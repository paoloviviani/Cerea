/**
 * A fake browser runtime for tests: the contract (`contract.ts`) over a scripted page model, in
 * process. It stands in for the engine on a user's machine, so the loop, the approvals and the
 * downloads are tested end to end without a browser.
 *
 * It behaves like the real runtime where the contract says so: refs are stable, `diff` reports
 * only what changed since the last snapshot (a full snapshot after navigation), `act` stops at
 * the first failure, and **a commit-class action without a grant matching it exactly is refused**
 * (the runtime's own half of ADR 0116 §4, using the same classifier and digest as Cerea).
 *
 * `asRuntimeCall()` serves the same behaviour at the wire level (JSON text, MCP image blocks), so
 * `McpBrowserRuntime` is tested against it too.
 */

import {
	type ActResult,
	type ActionResult,
	type ControlAction,
	type ControlResult,
	type InputEvent,
	type InputResult,
	type ScreencastResult,
	type ApprovalGrant,
	type BrowserAction,
	type BrowserRuntime,
	type Diff,
	type DownloadResult,
	type EndTaskResult,
	type ExtractRequest,
	type ExtractResult,
	type ResumeResult,
	type OpenRequest,
	type OpenResult,
	type TabsResult,
	type RuntimeToolName,
	type ScreenshotResult,
	type Snapshot,
	type SnapshotElement,
	BrowserRuntimeError,
	browserActionSchema,
	extractRequestSchema,
} from "./contract";
import { actionDigest, classifyAction } from "./classifier";
import { verifyGrant } from "./grants";

function originOf(url: string): string {
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
	} catch {
		return "";
	}
}
import type { RuntimeCall } from "./runtimeClient";

export interface FakeEffect {
	/** Navigate to the page with this id. */
	goto?: string;
	/** Offer a file for download. */
	download?: { name: string; mime?: string; content: string | Buffer };
	/** Add elements to the page. */
	reveal?: FakeElement[];
	/** Fail with this message. */
	fail?: string;
}

export type FakeElement = SnapshotElement & { onClick?: FakeEffect; onFill?: FakeEffect };

export interface FakePage {
	id: string;
	url: string;
	title: string;
	elements: FakeElement[];
	/** What `extract` returns on this page. */
	extract?: ExtractResult;
	/** A page the user opened themselves: `tabs()` lists it, `use_tab` adopts it. */
	userTab?: boolean;
	/** A bot check on this page: snapshot and diff carry it, and `act` refuses until it is solved. */
	challenge?: { kind: string };
}

/** The device key the fake runtime verifies grants with. */
export const FAKE_BROWSER_KEY = Buffer.alloc(32, 7);

/** A 1x1 PNG. */
export const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function renderElement(el: SnapshotElement): string {
	const bits = [`[${el.ref}]`, el.role, el.name ? `"${el.name}"` : ""];
	if (el.value) bits.push(`= "${el.value}"`);
	return bits.filter(Boolean).join(" ");
}

export class FakeBrowserRuntime implements BrowserRuntime {
	/** Every protocol call, in order, for assertions. */
	readonly calls: Array<{ tool: RuntimeToolName; args: Record<string, unknown> }> = [];
	/** Actions the fake really performed (not refused). */
	readonly performed: BrowserAction[] = [];
	/** How many times the task was ended, and keepalives sent. */
	ended = 0;
	pings = 0;
	/** Make the next call of a tool throw (a runtime that went away). */
	failNext: Partial<Record<RuntimeToolName, Error>> = {};

	private readonly pages = new Map<string, FakePage>();
	private currentId: string;
	private baseline = new Map<string, string>();
	private baselineUrl = "";
	private captured: Array<{
		name: string;
		mime: string;
		content: Buffer;
		actionIndex: number;
		grantId?: string;
	}> = [];
	private current: FakePage;
	private readonly adopted = new Set<string>();
	/** The page `end_task({keep})` left open, by token; `resume` finds it again. */
	private keptPages = new Map<
		string,
		{ id: string; title: string; url: string; lent?: { origin: string } }
	>();
	private keptCount = 0;
	private openedCount = 0;

	constructor(
		pages: FakePage[],
		start?: string,
		private readonly options: { key?: Buffer; now?: () => number } = {}
	) {
		for (const page of pages) {
			this.pages.set(page.id, {
				...page,
				elements: page.elements.map((e) => ({ ...e })),
			});
		}
		this.currentId = start ?? pages[0].id;
		const first = this.pages.get(this.currentId);
		if (!first) throw new Error(`No such page ${this.currentId}`);
		this.current = first;
	}

	get url(): string {
		return this.current.url;
	}

	/** Who drives the page: while `user`, every agent tool answers paused (phase 2a). */
	controller: "agent" | "user" = "agent";
	controlSource: "cerea" | "banner" | undefined;
	/** What the user did while in control, and the screencast calls, for tests. */
	readonly userInput: InputEvent[] = [];
	readonly screencastCalls: Array<Record<string, unknown>> = [];

	/** The user takes control in the window (the banner), as the real runtime's banner does. */
	bannerTakeover(): void {
		this.controller = "user";
		this.controlSource = "banner";
	}
	bannerHandback(): void {
		this.controller = "agent";
		this.controlSource = undefined;
	}

	async control(action: ControlAction): Promise<ControlResult> {
		this.calls.push({ tool: "control", args: { action } });
		if (action === "takeover" && this.controller !== "user") {
			this.controller = "user";
			this.controlSource = "cerea";
		} else if (action === "handback") {
			this.controller = "agent";
			this.controlSource = undefined;
			this.baseline = new Map();
			this.baselineUrl = "";
		}
		return {
			controller: this.controller,
			...(this.controlSource ? { source: this.controlSource } : {}),
		};
	}

	async screencast(
		request:
			{ action: "start"; width?: number } | { action: "stop" } | { action: "ack"; seq: number }
	): Promise<ScreencastResult> {
		this.screencastCalls.push({ ...request });
		return { casting: request.action !== "stop" };
	}

	async input(events: InputEvent[]): Promise<InputResult> {
		if (this.controller !== "user") {
			throw new BrowserRuntimeError("Input is accepted only while the user is in control.", "tool");
		}
		this.userInput.push(...events);
		return { sent: events.length, dropped: 0 };
	}

	private record(tool: RuntimeToolName, args: Record<string, unknown>): void {
		if (this.controller === "user" && tool !== "end_task" && tool !== "open") {
			this.calls.push({ tool, args });
			throw new BrowserRuntimeError("The user has taken control of the browser.", "paused");
		}
		this.calls.push({ tool, args });
		const failure = this.failNext[tool];
		if (failure) {
			delete this.failNext[tool];
			throw failure;
		}
	}

	private strip(el: FakeElement): SnapshotElement {
		const { onClick: _onClick, onFill: _onFill, ...rest } = el;
		void _onClick;
		void _onFill;
		return rest;
	}

	private fingerprint(el: SnapshotElement): string {
		return JSON.stringify([el.role, el.name, el.value ?? "", el.disabled ?? false]);
	}

	private take(): Snapshot {
		const elements = this.current.elements.map((e) => this.strip(e));
		this.baseline = new Map(elements.map((e) => [e.ref, this.fingerprint(e)]));
		this.baselineUrl = this.current.url;
		return {
			url: this.current.url,
			title: this.current.title,
			text: elements.map(renderElement).join("\n"),
			elements,
			...(this.current.challenge ? { challenge: this.current.challenge } : {}),
		};
	}

	/** A bot check appears on the current page (tests). */
	raiseChallenge(kind: string): void {
		this.current.challenge = { kind };
	}

	/** The title of a page changes under the user (tests). */
	retitle(id: string, title: string): void {
		const page = this.pages.get(id);
		if (page) page.title = title;
	}

	/** The user solved the check in the window. */
	solveChallenge(): void {
		delete this.current.challenge;
	}

	async snapshot(): Promise<Snapshot> {
		this.record("snapshot", {});
		return this.take();
	}

	async diff(): Promise<Diff> {
		this.record("diff", {});
		if (this.baselineUrl !== this.current.url) {
			const snapshot = this.take();
			return {
				url: snapshot.url,
				title: snapshot.title,
				navigated: true,
				added: [],
				changed: [],
				removed: [],
				text: snapshot.text,
				snapshot,
				...(this.current.challenge ? { challenge: this.current.challenge } : {}),
			};
		}
		const now = this.current.elements.map((e) => this.strip(e));
		const added = now.filter((e) => !this.baseline.has(e.ref));
		const changed = now.filter(
			(e) => this.baseline.has(e.ref) && this.baseline.get(e.ref) !== this.fingerprint(e)
		);
		const refs = new Set(now.map((e) => e.ref));
		const removed = [...this.baseline.keys()].filter((ref) => !refs.has(ref));
		this.baseline = new Map(now.map((e) => [e.ref, this.fingerprint(e)]));
		const lines = [
			...added.map((e) => `+ ${renderElement(e)}`),
			...changed.map((e) => `~ ${renderElement(e)}`),
			...removed.map((ref) => `- [${ref}]`),
		];
		return {
			url: this.current.url,
			title: this.current.title,
			navigated: false,
			added,
			changed,
			removed,
			text: lines.length > 0 ? lines.join("\n") : "(no change)",
			...(this.current.challenge ? { challenge: this.current.challenge } : {}),
		};
	}

	async act(actions: BrowserAction[], approvals?: ApprovalGrant[]): Promise<ActResult> {
		this.record("act", { actions, ...(approvals ? { approvals } : {}) });
		const results: ActionResult[] = [];
		const downloads: Array<{
			name: string;
			mime?: string;
			actionIndex: number;
			grantId?: string;
		}> = [];
		for (let index = 0; index < actions.length; index += 1) {
			const action = actions[index];
			const element =
				"ref" in action && action.ref
					? this.current.elements.find((e) => e.ref === action.ref)
					: undefined;
			if ("ref" in action && action.ref && !element) {
				results.push({ ok: false, error: `No element with ref ${action.ref} on this page.` });
				break;
			}
			if (this.current.challenge) {
				results.push({ ok: false, refused: "challenge", error: "a verification is on the page" });
				break;
			}
			const tabPage = action.type === "use_tab" ? this.pages.get(action.tab) : undefined;
			if (action.type === "use_tab" && !tabPage) {
				results.push({ ok: false, error: `No tab ${action.tab}.` });
				break;
			}
			const ctx = {
				element: element ? this.strip(element) : undefined,
				currentUrl: this.current.url,
				...(tabPage ? { tab: { id: tabPage.id, url: tabPage.url, title: tabPage.title } } : {}),
			};
			// The runtime's own refusals: a non-web address, and a commit without a valid grant.
			if (
				action.type === "navigate" &&
				!/^https?:\/\//i.test(action.url) &&
				action.url !== "about:blank"
			) {
				results.push({ ok: false, refused: "scheme_refused", error: "address not allowed" });
				break;
			}
			const grant = approvals?.find((a) => a.index === index);
			if (classifyAction(action, ctx).class === "commit") {
				if (!grant) {
					results.push({ ok: false, refused: "approval_required", error: "approval required" });
					break;
				}
				const checked = verifyGrant(
					this.options.key ?? FAKE_BROWSER_KEY,
					grant,
					this.options.now?.() ?? Date.now()
				);
				if (checked === "expired") {
					results.push({ ok: false, refused: "approval_expired", error: "approval expired" });
					break;
				}
				if (checked === "bad" || grant.digest !== actionDigest(action, ctx)) {
					results.push({
						ok: false,
						refused: "approval_mismatch",
						error: "approval does not match",
					});
					break;
				}
			}
			const outcome = this.perform(action, element, downloads, index, grant?.id);
			results.push(outcome);
			if (!outcome.ok) break;
			this.performed.push(action);
		}
		return {
			results,
			url: this.current.url,
			title: this.current.title,
			...(downloads.length > 0 ? { downloads } : {}),
		};
	}

	private perform(
		action: BrowserAction,
		element: FakeElement | undefined,
		downloads: Array<{ name: string; mime?: string; actionIndex: number; grantId?: string }>,
		index: number,
		grantId: string | undefined
	): ActionResult {
		switch (action.type) {
			case "click": {
				const effect = element?.onClick;
				if (element?.disabled) return { ok: false, error: `${element.name} is disabled.` };
				if (effect?.fail) return { ok: false, error: effect.fail };
				if (effect?.reveal) this.current.elements.push(...effect.reveal.map((e) => ({ ...e })));
				if (effect?.download) {
					const content = Buffer.from(effect.download.content);
					this.captured.push({
						name: effect.download.name,
						mime: effect.download.mime ?? "application/octet-stream",
						content,
						actionIndex: index,
						grantId,
					});
					downloads.push({
						name: effect.download.name,
						mime: effect.download.mime,
						actionIndex: index,
						grantId,
					});
				}
				if (effect?.goto) return this.goto(effect.goto, "clicked");
				return { ok: true, outcome: "clicked" };
			}
			case "fill":
				if (element?.onFill?.reveal)
					this.current.elements.push(...element.onFill.reveal.map((e) => ({ ...e })));
				if (element) element.value = element.inputType === "password" ? undefined : action.text;
				return { ok: true, outcome: `typed ${action.text.length} characters` };
			case "select":
				if (element) element.value = action.value;
				return { ok: true, outcome: `chose ${action.value}` };
			case "press":
				return { ok: true, outcome: `pressed ${action.key}` };
			case "scroll":
				return { ok: true, outcome: `scrolled ${action.direction}` };
			case "wait_for":
				return { ok: true, outcome: "waited" };
			case "use_tab":
				this.adopted.add(action.tab);
				return this.goto(action.tab, "using your tab");
			case "navigate": {
				const page = [...this.pages.values()].find((p) => p.url === action.url);
				if (!page) return { ok: false, error: `Could not load ${action.url}.` };
				return this.goto(page.id, "navigated");
			}
		}
	}

	private goto(id: string, outcome: string): ActionResult {
		const page = this.pages.get(id);
		if (!page) return { ok: false, error: `No such page ${id}.` };
		this.currentId = id;
		this.current = page;
		return { ok: true, outcome };
	}

	async extract(request: ExtractRequest): Promise<ExtractResult> {
		this.record("extract", { ...request });
		return this.current.extract ?? { tables: [], lists: [] };
	}

	async screenshot(ref?: string): Promise<ScreenshotResult> {
		this.record("screenshot", ref ? { ref } : {});
		if (ref && !this.current.elements.some((e) => e.ref === ref)) {
			throw new BrowserRuntimeError(`No element with ref ${ref}.`, "tool");
		}
		return { mime: "image/png", base64: TINY_PNG_BASE64 };
	}

	async download(): Promise<DownloadResult> {
		this.record("download", {});
		const files = this.captured.map((file) => ({
			name: file.name,
			mime: file.mime,
			size: file.content.byteLength,
			base64: file.content.toString("base64"),
			actionIndex: file.actionIndex,
			...(file.grantId ? { grantId: file.grantId } : {}),
		}));
		this.captured = [];
		return { files };
	}

	async tabs(options?: { deny?: string[] }): Promise<TabsResult> {
		this.record("tabs", options?.deny ? { deny: options.deny } : {});
		return {
			tabs: [...this.pages.values()]
				.filter((p) => p.userTab || p.id === this.currentId)
				.map((p) => ({
					id: p.id,
					title: p.title,
					url: p.url,
					mine: !p.userTab || this.adopted.has(p.id),
				})),
		};
	}

	async resume(token: string): Promise<ResumeResult> {
		this.record("resume", { token });
		const kept = this.keptPages.get(token);
		const page = kept ? this.pages.get(kept.id) : undefined;
		if (!kept || !page) throw new BrowserRuntimeError("That page is no longer open.", "tool");
		this.keptPages.delete(token);
		if (kept.lent) {
			// A lent tab moves freely on its site (a multi-step form), but not off it.
			if (originOf(page.url) !== kept.lent.origin || kept.lent.origin === "") {
				return { refused: "page_changed", title: page.title, url: page.url };
			}
			this.goto(page.id, "resumed");
			this.adopted.add(page.id);
			return { id: page.id, title: page.title, url: page.url, changed: false, lent: true };
		}
		this.goto(page.id, "resumed");
		const changed = page.url !== kept.url || page.title !== kept.title;
		return {
			id: page.id,
			title: page.title,
			url: page.url,
			changed,
			...(changed ? { was: { title: kept.title, url: kept.url } } : {}),
		};
	}

	async open(request?: OpenRequest): Promise<OpenResult> {
		this.record("open", {
			...(request?.url ? { url: request.url } : {}),
			...(request?.deny ? { deny: request.deny } : {}),
		});
		const raw = request?.url?.trim() || "about:blank";
		let url: string;
		try {
			const parsed = new URL(raw);
			const ok =
				parsed.protocol === "http:" || parsed.protocol === "https:" || raw === "about:blank";
			if (!ok) throw new Error("scheme");
			url = raw === "about:blank" ? raw : parsed.toString();
		} catch {
			throw new BrowserRuntimeError(
				"Only http and https addresses can be opened (about:blank too).",
				"tool"
			);
		}
		this.openedCount += 1;
		const id = `opened-${this.openedCount}`;
		const known = [...this.pages.values()].find((p) => p.url === url);
		const page = {
			id,
			url,
			title: known?.title ?? (url === "about:blank" ? "" : new URL(url).hostname),
			elements: known ? known.elements.map((e) => ({ ...e })) : [],
			userTab: true,
		};
		this.pages.set(id, page);
		this.keptCount += 1;
		const token = `kept-token-${this.keptCount}`;
		this.keptPages.set(token, { id, title: page.title, url: page.url });
		return { token, id, title: page.title, url: page.url };
	}

	async endTask(options?: { keep?: boolean }): Promise<EndTaskResult> {
		this.record("end_task", options?.keep ? { keep: true } : {});
		this.controller = "agent";
		this.controlSource = undefined;
		this.ended += 1;
		const adoptedBefore = new Set(this.adopted);
		this.adopted.clear();
		if (!options?.keep) return { closed: true };
		this.keptCount += 1;
		const token = `kept-token-${this.keptCount}`;
		const page = { id: this.current.id, title: this.current.title, url: this.current.url };
		if (adoptedBefore.has(page.id)) {
			const origin = originOf(page.url);
			this.keptPages.set(token, { ...page, lent: { origin } });
			return { closed: false, kept: { token, ...page, lent: true, origin } };
		}
		this.keptPages.set(token, page);
		return { closed: false, kept: { token, ...page } };
	}

	async keepAlive(): Promise<void> {
		this.pings += 1;
	}

	/** The same runtime at the wire level: what an MCP server would answer, for `McpBrowserRuntime`. */
	asRuntimeCall(): RuntimeCall {
		return async (tool, args) => {
			const json = (value: unknown) => ({
				text: JSON.stringify(value),
				isError: false as const,
			});
			try {
				switch (tool) {
					case "snapshot":
						return json(await this.snapshot());
					case "diff":
						return json(await this.diff());
					case "act": {
						const actions = (args.actions as unknown[]).map((a) => browserActionSchema.parse(a));
						return json(await this.act(actions, args.approvals as ApprovalGrant[] | undefined));
					}
					case "extract":
						return json(await this.extract(extractRequestSchema.parse(args)));
					case "screenshot": {
						const shot = await this.screenshot(args.ref as string | undefined);
						return {
							text: "",
							isError: false,
							content: [{ type: "image", data: shot.base64, mimeType: shot.mime }],
						};
					}
					case "download":
						return json(await this.download());
					case "tabs":
						return json(await this.tabs(args.deny ? { deny: args.deny as string[] } : undefined));
					case "resume":
						return json(await this.resume(String(args.token ?? "")));
					case "open":
						return json(
							await this.open({
								...(typeof args.url === "string" ? { url: args.url } : {}),
								...(Array.isArray(args.deny) ? { deny: args.deny as string[] } : {}),
							})
						);
					case "end_task":
						return json(await this.endTask(args.keep === true ? { keep: true } : undefined));
					case "control":
						return json(await this.control(args.action as ControlAction));
					case "screencast":
						return json(await this.screencast(args as { action: "start"; width?: number }));
					case "input":
						return json(await this.input(args.events as InputEvent[]));
				}
			} catch (err) {
				if (err instanceof BrowserRuntimeError && err.kind === "paused") {
					return {
						text: err.message,
						isError: true,
						structured: { paused: true },
					};
				}
				return { text: err instanceof Error ? err.message : String(err), isError: true };
			}
		};
	}
}
