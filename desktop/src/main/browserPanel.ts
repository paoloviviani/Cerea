/**
 * The embedded browser: tabs (WebContentsViews with their own session, apart from the Cerea
 * window's), the user's controls over them, and the `TargetHost` the CDP bridge drives. The
 * bridge is given this object and nothing else, so the Cerea window's webContents are not
 * reachable from the runtime.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	app,
	BrowserWindow,
	WebContentsView,
	session,
	type DownloadItem,
	type WebContents,
} from "electron";
import type { DownloadEvent, Json, PageTarget, TargetHost } from "./cdpBridge.ts";
import type { Control } from "./control.ts";
import { guardPanel } from "./navGuard.ts";
import { RateLimit } from "./rateLimit.ts";
import type { BrowserState } from "../shared/ipc.ts";

/** The most tabs the panel holds, whoever opens them. */
export const MAX_TABS = 20;

class ElectronPage implements PageTarget {
	private attached = false;
	private eventCbs = new Set<(m: string, p: Json, s?: string) => void>();
	private detachCbs = new Set<() => void>();
	private readonly onMessage = (_e: unknown, method: string, params: Json, sessionId?: string) => {
		for (const cb of this.eventCbs) cb(method, params ?? {}, sessionId || undefined);
	};
	private readonly detachHandler = (_e: unknown, reason?: string) => {
		if (process.env.CEREA_DEBUG) process.stderr.write(`debugger detached: ${reason}\n`);
		this.attached = false;
		for (const cb of this.detachCbs) cb();
	};

	constructor(
		/** The main frame's id: Playwright keys a page's session by it and expects it to equal the target id. */
		readonly id: string,
		readonly wc: WebContents
	) {}

	send(method: string, params: Json, childSession?: string): Promise<unknown> {
		if (!this.attached) return Promise.reject(new Error("Target closed"));
		return this.wc.debugger.sendCommand(method, params, childSession);
	}
	onEvent(cb: (m: string, p: Json, s?: string) => void): () => void {
		this.eventCbs.add(cb);
		return () => this.eventCbs.delete(cb);
	}
	onDetach(cb: () => void): () => void {
		this.detachCbs.add(cb);
		return () => this.detachCbs.delete(cb);
	}
	attach(): void {
		if (this.attached || this.wc.isDestroyed()) return;
		if (!this.wc.debugger.isAttached()) this.wc.debugger.attach("1.3");
		this.attached = true;
		this.wc.debugger.on("message", this.onMessage);
		this.wc.debugger.on("detach", this.detachHandler);
	}
	detach(): void {
		if (!this.attached) return;
		this.attached = false;
		this.eventCbs.clear();
		this.detachCbs.clear();
		if (this.wc.isDestroyed()) return;
		this.wc.debugger.removeListener("message", this.onMessage);
		this.wc.debugger.removeListener("detach", this.detachHandler);
		try {
			this.wc.debugger.detach();
		} catch {
			// already gone
		}
	}
	/**
	 * Freeze or thaw the page (CDP `Page.setWebLifecycleState`): a frozen page runs no timers or
	 * scripts. Uses the bridge's attachment when there is one, else attaches just for the call.
	 */
	async setLifecycle(state: "frozen" | "active"): Promise<void> {
		if (this.wc.isDestroyed()) return;
		try {
			if (this.attached) {
				await this.wc.debugger.sendCommand("Page.setWebLifecycleState", { state });
				return;
			}
			this.wc.debugger.attach("1.3");
			try {
				await this.wc.debugger.sendCommand("Page.setWebLifecycleState", { state });
			} finally {
				this.wc.debugger.detach();
			}
		} catch {
			// a page that cannot be frozen (loading, crashed) simply keeps running
		}
	}
	initialNavigate(url: string): void {
		if (!this.wc.isDestroyed() && guardPanel(url) === "allow")
			void this.wc.loadURL(url).catch(() => {});
	}
	url(): string {
		return this.wc.isDestroyed() ? "" : this.wc.getURL() || "about:blank";
	}
	title(): string {
		return this.wc.isDestroyed() ? "" : this.wc.getTitle();
	}
}

interface Tab {
	page: ElectronPage;
	view: WebContentsView;
}

export class BrowserPanel implements TargetHost {
	private readonly tabs = new Map<string, Tab>();
	private activeId?: string;
	private rect = { x: 0, y: 0, width: 0, height: 0, visible: false };
	private downloadDir: string | null = null;
	private readonly created = new Set<(t: PageTarget) => void>();
	private readonly destroyed = new Set<(id: string) => void>();
	private readonly downloads = new Set<(d: DownloadEvent) => void>();
	/** Covers the page while the runtime works, so a stray click cannot disturb it. */
	private shield?: WebContentsView;
	/** The window can be seen (not hidden or minimised) and the panel is open. */
	private windowVisible = true;
	private idleTimer?: NodeJS.Timeout;
	private frozen = false;
	/** On battery, asleep or locked: hidden pages are frozen sooner. */
	lowPower = false;

	constructor(
		private readonly win: BrowserWindow,
		private readonly control: Control,
		private readonly emit: (s: BrowserState) => void,
		private readonly isConnected: () => boolean,
		/** This profile's own session: cookies and logins of the panel never reach another profile's. */
		private readonly partition: string
	) {
		const ses = session.fromPartition(partition);
		// A page in the panel asks for nothing: no camera, location, notifications, clipboard read.
		ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
		ses.setPermissionCheckHandler(() => false);
		// Registered once per panel and removed with it, so switching back and forth does not pile them up.
		this.onDownloadEvent = (_e, item, wc) => this.onWillDownload(item, wc);
		ses.on("will-download", this.onDownloadEvent);
		this.offDownload = () => ses.removeListener("will-download", this.onDownloadEvent);
		this.offControl = control.onChange(() => this.refresh());
		const seen = () => this.setWindowVisible(win.isVisible() && !win.isMinimized());
		win.on("minimize", seen);
		win.on("hide", seen);
		win.on("restore", seen);
		win.on("show", seen);
		this.offWindow.push(
			() => win.removeListener("minimize", seen),
			() => win.removeListener("hide", seen),
			() => win.removeListener("restore", seen),
			() => win.removeListener("show", seen)
		);
	}

	private onDownloadEvent: (e: unknown, item: DownloadItem, wc: WebContents | null) => void;
	private offDownload: () => void = () => {};
	private offControl: () => void = () => {};
	private readonly offWindow: (() => void)[] = [];
	private disposed = false;

	/**
	 * Closes every tab and lets go of the window and the control gate: the panel of a profile that
	 * is left. Nothing of it can be reached afterwards (the bridge is detached first, by the caller).
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.idleTimer);
		this.offControl();
		this.offDownload();
		for (const off of this.offWindow) off();
		for (const id of [...this.tabs.keys()]) this.close(id);
		this.created.clear();
		this.destroyed.clear();
		this.downloads.clear();
		if (this.shield) {
			try {
				this.win.contentView.removeChildView(this.shield);
				this.shield.webContents.close();
			} catch {
				// the window is closing
			}
			this.shield = undefined;
		}
	}

	// ---- the user's side -------------------------------------------------------------------

	state(): BrowserState {
		return {
			tabs: [...this.tabs.values()].map((t) => ({
				id: t.page.id,
				title: t.page.title(),
				url: t.page.url(),
				active: t.page.id === this.activeId,
			})),
			mode: this.control.mode,
			agentBusy: this.control.agentBusy,
			connected: this.isConnected(),
		};
	}

	refresh(): void {
		this.layout();
		this.emit(this.state());
	}

	setLayout(r: { x: number; y: number; width: number; height: number; visible: boolean }): void {
		this.rect = r;
		this.layout();
	}

	private layout(): void {
		for (const t of this.tabs.values()) {
			const show = this.rect.visible && t.page.id === this.activeId;
			t.view.setVisible(show);
			if (show) t.view.setBounds(this.rect);
		}
		const shield = this.rect.visible && this.control.mode === "agent" && this.control.agentBusy;
		if (shield) {
			// Made on first need: a view is a renderer process, and most sessions never need this one.
			this.shield ??= (() => {
				const v = new WebContentsView({
					webPreferences: {
						sandbox: true,
						contextIsolation: true,
						nodeIntegration: false,
						backgroundThrottling: true,
						devTools: !app.isPackaged,
					},
				});
				v.setBackgroundColor("#00000000");
				return v;
			})();
			this.shield.setVisible(true);
			this.shield.setBounds(this.rect);
			// Always the topmost child, above the active tab.
			this.win.contentView.addChildView(this.shield);
		} else this.shield?.setVisible(false);
		this.scheduleIdle();
	}

	setWindowVisible(v: boolean): void {
		this.windowVisible = v;
		this.scheduleIdle();
	}

	/**
	 * Nothing to see and no task running: mute the tabs and freeze them. One timer, set only on a
	 * change (not a poll): 30 s of grace on mains power so a quick look away costs nothing, 3 s on
	 * battery, and at once when the machine sleeps or locks (`lowPower` with `now`).
	 */
	scheduleIdle(now = false): void {
		clearTimeout(this.idleTimer);
		const idle =
			!(this.windowVisible && this.rect.visible) && !this.control.recentlyActive(120_000);
		if (!idle) {
			if (this.frozen) this.setFrozen(false);
			for (const t of this.tabs.values()) t.page.wc.setAudioMuted(false);
			return;
		}
		for (const t of this.tabs.values()) t.page.wc.setAudioMuted(true);
		const delay = now ? 0 : this.lowPower ? 3000 : 30_000;
		this.idleTimer = setTimeout(() => this.setFrozen(true), delay);
		this.idleTimer.unref();
	}

	private setFrozen(on: boolean): void {
		this.frozen = on;
		for (const t of this.tabs.values()) void t.page.setLifecycle(on ? "frozen" : "active");
	}

	/** A page the user asked for (address bar): http(s) only; a bare host gets https. */
	openForUser(input: string): void {
		const text = input.trim();
		const url = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
		if (guardPanel(url) !== "allow") return;
		void this.create()
			.then((t) => {
				(t as ElectronPage).initialNavigate(url);
				this.activate(t.id);
			})
			.catch(() => {}); // at the tab cap there is nothing to open
	}

	navigate(action: "back" | "forward" | "reload"): void {
		const tab = this.activeId ? this.tabs.get(this.activeId) : undefined;
		if (!tab) return;
		const nav = tab.page.wc.navigationHistory;
		if (action === "back" && nav.canGoBack()) nav.goBack();
		else if (action === "forward" && nav.canGoForward()) nav.goForward();
		else if (action === "reload") tab.page.wc.reload();
	}

	private readonly popupLimit = new RateLimit(5, 10_000);

	// ---- TargetHost ------------------------------------------------------------------------

	targets(): PageTarget[] {
		return [...this.tabs.values()].map((t) => t.page);
	}

	async create(): Promise<PageTarget> {
		if (this.disposed) throw new Error("This panel is closed.");
		if (this.tabs.size >= MAX_TABS) throw new Error(`The panel holds at most ${MAX_TABS} tabs.`);
		const view = new WebContentsView({
			webPreferences: {
				partition: this.partition,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webSecurity: true,
				spellcheck: false,
				backgroundThrottling: true,
				// A page in the panel gets no preload and no Node: it is the open web.
			},
		});
		const wc = view.webContents;
		// Committed first, so there is a frame; its id is the target id (see ElectronPage).
		await wc.loadURL("about:blank").catch(() => {});
		const id = await mainFrameId(wc);
		const page = new ElectronPage(id, wc);
		const tab: Tab = { page, view };
		this.tabs.set(id, tab);
		view.setVisible(false);
		this.win.contentView.addChildView(view);
		// Navigation: web pages only. A popup becomes a tab of the panel (so the runtime sees it).
		const block = (e: { preventDefault(): void }, to: string) => {
			if (guardPanel(to) !== "allow") e.preventDefault();
		};
		wc.on("will-navigate", (e, to) => block(e, to));
		wc.on("will-redirect", (e, to) => block(e, to));
		// A navigation started over CDP (Page.navigate) skips will-navigate: this catches what the
		// bridge's own URL check did not, and puts the page back on a blank document.
		wc.on("did-start-navigation", (details) => {
			if (details.isMainFrame && guardPanel(details.url) !== "allow") {
				wc.stop();
				void wc.loadURL("about:blank").catch(() => {});
			}
		});
		wc.setWindowOpenHandler(({ url: to }) => {
			// A popup is a background tab: it is not shown unless the user picks it. At most MAX_TABS
			// tabs, and five popups in ten seconds, so a page cannot flood the panel.
			if (guardPanel(to) === "allow" && this.tabs.size < MAX_TABS && this.popupLimit.take()) {
				void this.create()
					.then((t) => (t as ElectronPage).initialNavigate(to))
					.catch(() => {});
			}
			return { action: "deny" };
		});
		wc.on("page-title-updated", () => this.refresh());
		wc.on("did-navigate", () => this.refresh());
		wc.on("did-navigate-in-page", () => this.refresh());
		wc.on("destroyed", () => this.drop(id));
		// Every page starts as a committed blank page, and is returned only then: a view with no
		// document has no frame for CDP to talk to, and one that is still swapping its first frame
		// makes Playwright's newPage fail with "Frame has been detached".
		for (const cb of this.created) cb(page);
		if (!this.activeId) this.activate(id);
		this.refresh();
		return page;
	}

	close(id: string): void {
		const tab = this.tabs.get(id);
		if (!tab) return;
		tab.page.detach();
		if (!tab.page.wc.isDestroyed()) tab.page.wc.close();
		this.drop(id);
	}

	private drop(id: string): void {
		const tab = this.tabs.get(id);
		if (!tab) return;
		if (process.env.CEREA_DEBUG) process.stderr.write(`drop ${id} ${new Error().stack}\n`);
		this.tabs.delete(id);
		try {
			this.win.contentView.removeChildView(tab.view);
		} catch {
			// the window is closing
		}
		if (this.activeId === id) this.activeId = [...this.tabs.keys()].at(-1);
		for (const cb of this.destroyed) cb(id);
		this.refresh();
	}

	activate(id: string): void {
		if (!this.tabs.has(id)) return;
		this.activeId = id;
		this.refresh();
	}

	onTargetCreated(cb: (t: PageTarget) => void): () => void {
		this.created.add(cb);
		return () => this.created.delete(cb);
	}
	onTargetDestroyed(cb: (id: string) => void): () => void {
		this.destroyed.add(cb);
		return () => this.destroyed.delete(cb);
	}
	setDownloadDir(dir: string | null): void {
		this.downloadDir = dir;
	}
	onDownload(cb: (d: DownloadEvent) => void): () => void {
		this.downloads.add(cb);
		return () => this.downloads.delete(cb);
	}
	bounds() {
		const b = this.win.getContentBounds();
		return { left: 0, top: 0, width: b.width, height: b.height };
	}

	private onWillDownload(item: DownloadItem, wc: WebContents | null): void {
		const dir = this.downloadDir;
		// Saved silently only while the runtime is working and asked for it; any other download, a
		// user's or a page's own, is Electron's usual one that asks where to save.
		if (!dir || this.downloads.size === 0) return;
		if (this.control.mode === "user" || !this.control.recentlyActive(30_000)) return;
		const guid = randomUUID();
		item.setSavePath(join(dir, guid));
		let state: "inProgress" | "completed" | "canceled" = "inProgress";
		const cbs: ((received: number, total: number, s: typeof state) => void)[] = [];
		const report = () => {
			for (const cb of cbs) cb(item.getReceivedBytes(), item.getTotalBytes(), state);
		};
		item.on("updated", report);
		item.once("done", (_e, s) => {
			state = s === "completed" ? "completed" : "canceled";
			report();
		});
		void (async () => {
			let frameId = "";
			const tab = [...this.tabs.values()].find((t) => t.page.wc === wc);
			try {
				const tree = (await tab?.page.send("Page.getFrameTree", {})) as {
					frameTree?: { frame?: { id?: string } };
				};
				frameId = tree?.frameTree?.frame?.id ?? "";
			} catch {
				// not attached: the runtime cannot be waiting for it
			}
			const event: DownloadEvent = {
				guid,
				url: item.getURL(),
				suggestedFilename: item.getFilename(),
				frameId,
				progress: (cb) => {
					cbs.push(cb);
					if (state !== "inProgress") cb(item.getReceivedBytes(), item.getTotalBytes(), state);
				},
			};
			for (const cb of this.downloads) cb(event);
		})();
	}
}

/** The id of a web contents' main frame, asked once over a short debugger attachment. */
async function mainFrameId(wc: WebContents): Promise<string> {
	const had = wc.debugger.isAttached();
	if (!had) wc.debugger.attach("1.3");
	try {
		const tree = (await wc.debugger.sendCommand("Page.getFrameTree")) as {
			frameTree: { frame: { id: string } };
		};
		return tree.frameTree.frame.id;
	} finally {
		if (!had) wc.debugger.detach();
	}
}
