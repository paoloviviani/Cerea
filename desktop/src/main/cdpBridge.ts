/**
 * The CDP bridge: what lets browser-runtime (Playwright over `connectOverCDP`) drive the desktop
 * app's browser panel, and nothing else.
 *
 * Chromium's own remote-debugging port or pipe would expose the whole app, the Cerea window
 * included, to anyone who can reach it, and CDP has no authentication. So the app opens neither.
 * It answers the small part of the browser-level protocol Playwright needs ("a browser with one
 * context and these pages") itself, and forwards page-level commands to the panel's pages through
 * `webContents.debugger`. A page that is not in the `TargetHost` is not reachable by
 * construction: there is no code path from a socket message to any other webContents.
 */

import {
	checkPageCommand,
	checkUrl,
	CHILD_TYPES,
	downloadDirOk,
	downloadDirSafe,
	isForwardableTargetEvent,
} from "./cdpPolicy.ts";

export type Json = Record<string, unknown>;

/** One page of the panel, as the bridge sees it. Implemented over a webContents in `browserPanel.ts`. */
export interface PageTarget {
	readonly id: string;
	/** Run a page-level CDP command on this page (or on a child session of it). */
	send(method: string, params: Json, childSession?: string): Promise<unknown>;
	/** Events and responses from the page's own CDP agent. Returns the unsubscribe. */
	onEvent(cb: (method: string, params: Json, childSession?: string) => void): () => void;
	onDetach(cb: () => void): () => void;
	attach(): void;
	detach(): void;
	/** The first navigation of a page the runtime asked for (what Chrome does once the client lets it start). */
	initialNavigate(url: string): void | Promise<void>;
	url(): string;
	title(): string;
}

export interface DownloadEvent {
	guid: string;
	url: string;
	suggestedFilename: string;
	frameId: string;
	/** Resolves with progress events until done; the host saves into `dir/guid`. */
	progress(
		cb: (received: number, total: number, state: "inProgress" | "completed" | "canceled") => void
	): void;
}

/** The panel, as the bridge sees it: the only pages the runtime may ever reach. */
export interface TargetHost {
	targets(): PageTarget[];
	/** A new page, committed on a blank document and not yet navigated anywhere. */
	create(): Promise<PageTarget>;
	close(id: string): void;
	activate(id: string): void;
	onTargetCreated(cb: (t: PageTarget) => void): () => void;
	onTargetDestroyed(cb: (id: string) => void): () => void;
	/** Where a download goes (the runtime asks for a directory); null refuses downloads. */
	setDownloadDir(dir: string | null): void;
	onDownload(cb: (d: DownloadEvent) => void): () => void;
	/** The window's size, for `Browser.getWindowForTarget`. */
	bounds(): { left: number; top: number; width: number; height: number };
}

/** Called with every command the runtime sends, before it runs: the take-over gate. */
export interface Gate {
	/** Resolves when the command may run; rejects (with a message) when it must not. */
	pass(method: string, targetId: string | undefined): Promise<void>;
	/** The runtime did something (activity feeds the "Cerea is browsing" indicator). */
	activity(): void;
	/** Who drives now. While the user does, the runtime has no session on any page. */
	current(): "agent" | "user";
	onChange(cb: () => void): () => void;
	/** A task is running now (the runtime did something recently): a second runtime is refused, not let in. */
	taskActive?(): boolean;
	/** A newcomer runtime was refused (`taskActive`); `windowRuntime` when it was the app's own. */
	refused?(windowRuntime: boolean): void;
}

export interface Transport {
	send(data: string): void;
	onMessage(cb: (data: string) => void): void;
	onClose(cb: () => void): void;
	close(reason?: string): void;
}

export const BRIDGE_PRODUCT = "Chrome/Cerea-desktop-panel";
const BROWSER_CONTEXT_ID = "cerea-panel-context";

interface Msg {
	id?: number;
	method?: string;
	params?: Json;
	sessionId?: string;
}

class Connection {
	private readonly sessions = new Map<string, PageTarget>(); // virtual top-level session -> page
	private readonly byTarget = new Map<string, string>(); // page id -> virtual session
	private readonly child = new Map<string, PageTarget>(); // child session id (from the page) -> page
	private readonly unsub: (() => void)[] = [];
	private seq = 0;
	private autoAttach = false;
	/** Pages made by `Target.createTarget`: their first navigation starts when the client says go. */
	private readonly pendingInitial = new Map<string, string>();
	private closed = false;
	get live(): boolean {
		return !this.closed;
	}

	constructor(
		private readonly host: TargetHost,
		private readonly gate: Gate,
		private readonly transport: Transport,
		private readonly log: (m: string) => void
	) {
		transport.onMessage((d) => void this.onMessage(d));
		transport.onClose(() => this.dispose());
		this.unsub.push(
			host.onTargetCreated((t) => {
				// A tab the user opens while they drive is theirs: the runtime is told once they hand back.
				if (this.autoAttach && this.gate.current() === "agent") this.attachTarget(t);
			}),
			host.onTargetDestroyed((id) => this.targetGone(id)),
			host.onDownload((d) => this.onDownload(d)),
			gate.onChange(() => this.modeChanged())
		);
	}

	private lastMode: "agent" | "user" = "agent";
	/**
	 * Taking over cuts the runtime off from the pages: every session is detached (Playwright sees
	 * the pages close), the debugger is released (its request interception ends, so no request
	 * waits for a runtime that is not there), and no event of what the user does reaches it. On
	 * hand-back every tab is attached again as a fresh page. The runtime then finds the pages as
	 * the user's own tabs, which is what they now are.
	 */
	private modeChanged(): void {
		const mode = this.gate.current();
		if (mode === this.lastMode || this.closed) return;
		this.lastMode = mode;
		if (mode === "user") {
			for (const [sessionId, t] of this.sessions) {
				t.detach();
				this.out({ method: "Target.detachedFromTarget", params: { sessionId, targetId: t.id } });
			}
			this.sessions.clear();
			this.byTarget.clear();
			this.child.clear();
			this.pendingInitial.clear();
			for (const u of this.pageUnsubs.splice(0)) u();
		} else if (this.autoAttach) {
			for (const t of this.host.targets()) this.attachTarget(t);
		}
	}
	private readonly pageUnsubs: (() => void)[] = [];

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const u of this.unsub) u();
		for (const t of this.sessions.values()) t.detach();
		this.sessions.clear();
		this.child.clear();
		// A connection that is let go is closed, not left open and mute.
		try {
			this.transport.close();
		} catch {
			// already closed
		}
	}

	private out(m: Json): void {
		if (!this.closed) this.transport.send(JSON.stringify(m));
	}

	private info(t: PageTarget, attached: boolean): Json {
		return {
			targetId: t.id,
			type: "page",
			title: t.title(),
			url: t.url(),
			attached,
			canAccessOpener: false,
			browserContextId: BROWSER_CONTEXT_ID,
		};
	}

	private attachTarget(t: PageTarget, waiting = false): void {
		if (this.byTarget.has(t.id)) return;
		const sessionId = `cerea-s${++this.seq}`;
		this.sessions.set(sessionId, t);
		this.byTarget.set(t.id, sessionId);
		t.attach();
		this.pageUnsubs.push(
			t.onEvent((method, params, childSession) => {
				if (this.gate.current() === "user") return;
				if (method.startsWith("Target.")) {
					if (!isForwardableTargetEvent(method)) return;
					if (method === "Target.attachedToTarget") {
						// Only a frame or worker of this page, reached from it by auto-attach, becomes a session.
						const parentOk = childSession === undefined || this.child.get(childSession) === t;
						const info = params.targetInfo as { type?: unknown } | undefined;
						const id = params.sessionId;
						if (
							!parentOk ||
							typeof id !== "string" ||
							typeof info?.type !== "string" ||
							!CHILD_TYPES.has(info.type)
						) {
							if (typeof id === "string") {
								void t
									.send("Target.detachFromTarget", { sessionId: id }, childSession)
									.catch(() => {});
							}
							return;
						}
						this.child.set(id, t);
					} else {
						const id = params.sessionId;
						if (typeof id !== "string" || !this.child.delete(id)) return;
					}
				}
				// An event of a child session the bridge never registered is not the runtime's to see.
				if (childSession !== undefined && !this.child.has(childSession)) return;
				this.out({ method, params, sessionId: childSession ?? sessionId });
			}),
			t.onDetach(() => this.targetGone(t.id))
		);
		this.out({
			method: "Target.attachedToTarget",
			params: { sessionId, targetInfo: this.info(t, true), waitingForDebugger: waiting },
		});
	}

	private targetGone(id: string): void {
		const sessionId = this.byTarget.get(id);
		if (!sessionId) return;
		this.byTarget.delete(id);
		this.sessions.delete(sessionId);
		this.out({ method: "Target.detachedFromTarget", params: { sessionId, targetId: id } });
		this.out({ method: "Target.targetDestroyed", params: { targetId: id } });
	}

	private onDownload(d: DownloadEvent): void {
		this.out({
			method: "Browser.downloadWillBegin",
			params: {
				frameId: d.frameId,
				guid: d.guid,
				url: d.url,
				suggestedFilename: d.suggestedFilename,
			},
		});
		d.progress((received, total, state) =>
			this.out({
				method: "Browser.downloadProgress",
				params: { guid: d.guid, totalBytes: total, receivedBytes: received, state },
			})
		);
	}

	private async onMessage(data: string): Promise<void> {
		let msg: Msg;
		try {
			msg = JSON.parse(data) as Msg;
		} catch {
			return;
		}
		if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
		const id = msg.id;
		const method = msg.method;
		const params = (msg.params ?? {}) as Json;
		try {
			const result = await this.dispatch(method, params, msg.sessionId);
			this.out({
				id,
				result: result ?? {},
				...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
			});
		} catch (err) {
			this.out({
				id,
				error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
				...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
			});
		}
	}

	private async dispatch(
		method: string,
		params: Json,
		sessionId: string | undefined
	): Promise<unknown> {
		if (sessionId === undefined) return this.browserLevel(method, params);
		const page = this.sessions.get(sessionId);
		const viaChild = page ? undefined : this.child.get(sessionId);
		const target = page ?? viaChild;
		if (!target) throw new Error(`No session ${sessionId}`);
		this.gate.activity();
		await this.gate.pass(method, target.id);
		checkPageCommand(method, params);
		// Only a page's own start (not a frame's or worker's) waits for the navigation to be released.
		if (page && method === "Runtime.runIfWaitingForDebugger") {
			const url = this.pendingInitial.get(target.id);
			if (url !== undefined) {
				this.pendingInitial.delete(target.id);
				// A blank start is finished before the client is answered: Playwright's newPage waits for
				// that navigation, and every event of it (a same-address load can commit twice) must
				// come before the reply, not during the goto that follows (CI saw "interrupted by
				// another navigation to about:blank"). A real address is left to load on its own.
				const nav = target.initialNavigate(url);
				if (url === "about:blank") await nav;
			}
			return {};
		}
		return target.send(method, params, page ? undefined : sessionId);
	}

	private async browserLevel(method: string, params: Json): Promise<unknown> {
		this.gate.activity();
		switch (method) {
			case "Browser.getVersion":
				return {
					protocolVersion: "1.3",
					product: BRIDGE_PRODUCT,
					revision: "0",
					userAgent: "Mozilla/5.0 Chrome (Cerea desktop panel)",
					jsVersion: "0",
				};
			case "Target.getTargetInfo":
				return {
					targetInfo: {
						targetId: "cerea-browser",
						type: "browser",
						title: "",
						url: "",
						attached: true,
						canAccessOpener: false,
					},
				};
			case "Target.setDiscoverTargets":
				return {};
			case "Target.getBrowserContexts":
				return { browserContextIds: [] };
			case "Target.setAutoAttach": {
				// Not while the user drives: it would watch (and, with waitForDebuggerOnStart, stall) their tabs.
				await this.gate.pass(method, undefined);
				this.autoAttach = params.autoAttach === true;
				if (this.autoAttach) for (const t of this.host.targets()) this.attachTarget(t);
				return {};
			}
			case "Target.getTargets":
				// While the user drives their tabs are not the runtime's to list.
				return {
					targetInfos:
						this.gate.current() === "user"
							? []
							: this.host.targets().map((t) => this.info(t, this.byTarget.has(t.id))),
				};
			case "Target.createTarget": {
				await this.gate.pass(method, undefined);
				const url = typeof params.url === "string" ? params.url : "about:blank";
				checkUrl(url);
				const t = await this.host.create();
				this.pendingInitial.set(t.id, url);
				this.attachTarget(t, true);
				return { targetId: t.id };
			}
			case "Target.closeTarget": {
				await this.gate.pass(method, undefined);
				const id = String(params.targetId);
				if (!this.host.targets().some((t) => t.id === id))
					throw new Error("No target with that id");
				this.host.close(id);
				return { success: true };
			}
			case "Target.activateTarget": {
				await this.gate.pass(method, undefined);
				const id = String(params.targetId);
				if (this.host.targets().some((t) => t.id === id)) this.host.activate(id);
				return {};
			}
			case "Browser.setDownloadBehavior": {
				// Only a scratch directory the runtime made (its own or Playwright's), never an arbitrary path.
				const dir = typeof params.downloadPath === "string" ? params.downloadPath : undefined;
				if (
					params.behavior !== "deny" &&
					dir !== undefined &&
					!(downloadDirOk(dir) && downloadDirSafe(dir))
				) {
					throw new Error("That download directory is not allowed.");
				}
				this.host.setDownloadDir(params.behavior === "deny" ? null : (dir ?? null));
				return {};
			}
			case "Browser.getWindowForTarget":
				return { windowId: 1, bounds: { ...this.host.bounds(), windowState: "normal" } };
			case "Browser.setWindowBounds":
			case "Browser.cancelDownload":
				return {};
			case "Browser.close":
				this.transport.close();
				return {};
			case "Target.disposeBrowserContext":
			case "Target.createBrowserContext":
				// One context only: the runtime may not make more, so there is nothing to isolate it from.
				throw new Error("This browser has one context and cannot make or drop others.");
			default:
				this.log(`unsupported browser-level method ${method}`);
				throw new Error(`'${method}' wasn't found`);
		}
	}
}

/**
 * The one door the runtime's socket opens onto, pointed at the active profile's bridge. A switch
 * disconnects the old bridge and, until the new profile's panel exists, closes every connection at
 * once, so a command aimed at a page of the profile that was left has nowhere to land.
 */
export const BUSY_MESSAGE = "Another task is using this browser.";

export class BridgeRouter {
	private current?: { connect(t: Transport, own?: boolean): void; disconnect(): void };
	set(next: { connect(t: Transport, own?: boolean): void; disconnect(): void } | undefined): void {
		this.current?.disconnect();
		this.current = next;
	}
	connect(t: Transport, own?: boolean): void {
		if (!this.current) return t.close();
		this.current.connect(t, own);
	}
	disconnect(): void {
		this.current?.disconnect();
	}
}

export class CdpBridge {
	private current?: Connection;

	constructor(
		private readonly host: TargetHost,
		private readonly gate: Gate,
		private readonly log: (m: string) => void = () => {}
	) {}

	/**
	 * A new runtime connection replaces an old one that is idle (one task at a time on a machine).
	 * While a task is running on the old one (a galopin runtime and the app's own window runtime
	 * contend for this panel), the newcomer is refused instead, so a running task is never cut off.
	 */
	connect(transport: Transport, windowRuntime = false): void {
		if (this.current?.live && this.gate.taskActive?.()) {
			this.log("another runtime was refused: a task is using this browser");
			this.gate.refused?.(windowRuntime);
			return transport.close(BUSY_MESSAGE);
		}
		this.current?.dispose();
		this.current = new Connection(this.host, this.gate, transport, this.log);
	}

	disconnect(): void {
		this.current?.dispose();
		this.current = undefined;
	}
}
