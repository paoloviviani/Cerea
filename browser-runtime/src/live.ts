/**
 * Live view and takeover (ADR 0116 phase 2a).
 *
 * Three things hang off the session's active page, none of them part of the six agent tools:
 *
 * - **Screencast.** CDP `Page.startScreencast` (JPEG, frames only when the page repaints). Each
 *   frame is acked to Chromium after a short minimum interval, and handed to the frame sink (the
 *   MCP server turns it into a notification galopin forwards as a binary frame). The sink is only
 *   offered a frame while the viewer has credit: a viewer that stops acking gets the newest frame
 *   later, never a queue. No viewer (no `start` or `ack` for a while) stops the cast by itself.
 * - **Control.** Who drives the page: the agent or the user. While the user does, every agent tool
 *   refuses with a "paused" error and a running batch stops at the next action (see `session.ts`).
 * - **Input.** The user's mouse, touch, keys and text, dispatched through CDP. Accepted only while
 *   the user is in control; the page cannot tell it from a person at the window.
 *
 * Plus the **banner** of a headed window: a small bar the runtime puts over a task page, in an
 * isolated world and a closed shadow root, whose button hands control to the user. See `Banner`.
 *
 * Nothing here stores or logs a frame.
 */

import { randomBytes } from "node:crypto";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { ToolError } from "./errors.ts";

/** The MCP notification a frame travels in (galopin turns it into a binary link frame). */
export const FRAME_METHOD = "notifications/cerea/frame";

export interface Frame {
	seq: number;
	/** The page viewport in CSS pixels: the coordinate space of `input`. */
	width: number;
	height: number;
	mime: "image/jpeg";
	/** Base64 JPEG. */
	data: string;
}
export type FrameSink = (frame: Frame) => void;

export type Controller = "agent" | "user";
export interface ControlState {
	controller: Controller;
	/** Who took control: Cerea's live view, or the banner in the window. */
	source?: "cerea" | "banner";
	/** Epoch milliseconds the user took control. */
	since?: number;
}

/** What the live part needs from the session. */
export interface LiveHost {
	activePage(): Page | undefined;
	context(): BrowserContext | undefined;
	/** The pages that belong to the task: only these get a banner. */
	taskPages(): Page[];
	/** Called on every input and heartbeat: the task is not idle while the user works. */
	touch(): void;
}

export interface LiveOptions {
	/** Show the banner on task pages (default: when the window is headed). */
	banner: boolean;
	/** Screencast frames in flight to the viewer before the next waits for an ack (default 3). */
	maxInFlight?: number;
	/** The shortest time between two frames sent on (default 80 ms: about 12 per second). */
	minFrameMs?: number;
	/** Stop the cast after this long without a start or an ack (default 25 s). */
	viewerTimeoutMs?: number;
}

const MAX_INPUT_EVENTS = 64;
const MAX_TEXT = 4_000;
const MAX_COORD = 20_000;
const MIN_WIDTH = 160;
const MAX_WIDTH = 1_600;
/** Events a second the runtime dispatches before it drops the rest (a mouse move per frame is far less). */
const EVENTS_PER_SECOND = 600;

export type InputEvent =
	| {
			type: "mouse";
			action: "move" | "down" | "up" | "wheel";
			x: number;
			y: number;
			button?: "left" | "middle" | "right";
			clickCount?: number;
			deltaX?: number;
			deltaY?: number;
			modifiers?: number;
	  }
	| {
			type: "touch";
			action: "start" | "move" | "end" | "cancel";
			points: Array<{ x: number; y: number; id?: number }>;
			modifiers?: number;
	  }
	| {
			type: "key";
			action: "down" | "up";
			key: string;
			code?: string;
			modifiers?: number;
	  }
	| { type: "text"; text: string };

/** The keys a person presses that are not text: their DOM `key` and Windows virtual key code. */
const SPECIAL_KEYS: Record<string, { code: string; vk: number }> = {
	Enter: { code: "Enter", vk: 13 },
	Backspace: { code: "Backspace", vk: 8 },
	Tab: { code: "Tab", vk: 9 },
	Escape: { code: "Escape", vk: 27 },
	Delete: { code: "Delete", vk: 46 },
	Insert: { code: "Insert", vk: 45 },
	ArrowLeft: { code: "ArrowLeft", vk: 37 },
	ArrowUp: { code: "ArrowUp", vk: 38 },
	ArrowRight: { code: "ArrowRight", vk: 39 },
	ArrowDown: { code: "ArrowDown", vk: 40 },
	Home: { code: "Home", vk: 36 },
	End: { code: "End", vk: 35 },
	PageUp: { code: "PageUp", vk: 33 },
	PageDown: { code: "PageDown", vk: 34 },
	" ": { code: "Space", vk: 32 },
	Shift: { code: "ShiftLeft", vk: 16 },
	Control: { code: "ControlLeft", vk: 17 },
	Alt: { code: "AltLeft", vk: 18 },
	Meta: { code: "MetaLeft", vk: 91 },
	F5: { code: "F5", vk: 116 },
};

const finite = (n: unknown, max = MAX_COORD): n is number =>
	typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= max;

/** Reads the `events` argument of the `input` tool: anything that is not exactly an event is an error. */
export function parseInputEvents(raw: unknown): InputEvent[] {
	if (!Array.isArray(raw) || raw.length === 0) throw new ToolError("input needs a list of events.");
	if (raw.length > MAX_INPUT_EVENTS) {
		throw new ToolError(`input takes at most ${MAX_INPUT_EVENTS} events at a time.`);
	}
	const out: InputEvent[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null)
			throw new ToolError("An input event is not an object.");
		const e = item as Record<string, unknown>;
		const modifiers =
			e.modifiers === undefined
				? undefined
				: Number.isInteger(e.modifiers)
					? (e.modifiers as number) & 15
					: NaN;
		if (Number.isNaN(modifiers)) throw new ToolError("modifiers must be an integer.");
		switch (e.type) {
			case "mouse": {
				if (!["move", "down", "up", "wheel"].includes(String(e.action))) {
					throw new ToolError("A mouse event's action is move, down, up or wheel.");
				}
				if (!finite(e.x) || !finite(e.y)) throw new ToolError("A mouse event needs x and y.");
				const button = e.button === undefined ? "left" : e.button;
				if (button !== "left" && button !== "middle" && button !== "right") {
					throw new ToolError("A mouse button is left, middle or right.");
				}
				out.push({
					type: "mouse",
					action: e.action as "move",
					x: e.x,
					y: e.y,
					button,
					clickCount: Number.isInteger(e.clickCount)
						? Math.min(3, Math.max(1, e.clickCount as number))
						: 1,
					deltaX: finite(e.deltaX, 100_000) ? (e.deltaX as number) : 0,
					deltaY: finite(e.deltaY, 100_000) ? (e.deltaY as number) : 0,
					modifiers,
				});
				break;
			}
			case "touch": {
				if (!["start", "move", "end", "cancel"].includes(String(e.action))) {
					throw new ToolError("A touch event's action is start, move, end or cancel.");
				}
				const points = Array.isArray(e.points) ? e.points : [];
				if (
					points.length > 10 ||
					(points.length === 0 && e.action !== "end" && e.action !== "cancel")
				) {
					throw new ToolError("A touch event has 1 to 10 points.");
				}
				out.push({
					type: "touch",
					action: e.action as "start",
					points: points.map((p, i) => {
						const q = (p ?? {}) as Record<string, unknown>;
						if (!finite(q.x) || !finite(q.y)) throw new ToolError("A touch point needs x and y.");
						return { x: q.x, y: q.y, id: Number.isInteger(q.id) ? (q.id as number) : i };
					}),
					modifiers,
				});
				break;
			}
			case "key": {
				if (e.action !== "down" && e.action !== "up")
					throw new ToolError("A key event's action is down or up.");
				if (typeof e.key !== "string" || !(e.key in SPECIAL_KEYS)) {
					throw new ToolError(
						"Only special keys are sent as key events: type text with a text event."
					);
				}
				out.push({ type: "key", action: e.action, key: e.key, modifiers });
				break;
			}
			case "text": {
				if (typeof e.text !== "string" || e.text.length === 0 || e.text.length > MAX_TEXT) {
					throw new ToolError(`A text event has 1 to ${MAX_TEXT} characters.`);
				}
				out.push({ type: "text", text: e.text });
				break;
			}
			default:
				throw new ToolError("An input event's type is mouse, touch, key or text.");
		}
	}
	return out;
}

/** Thrown to the agent's tools while the user is in control. */
export class PausedError extends ToolError {
	constructor() {
		super(
			"paused: the user has taken control of the browser. Wait; Cerea resumes you with a fresh page."
		);
		this.name = "PausedError";
	}
}

const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const;

export class LiveView {
	private readonly host: LiveHost;
	private readonly options: LiveOptions;
	private state: ControlState = { controller: "agent" };
	private readonly cdps = new WeakMap<Page, Promise<CDPSession>>();
	private banner?: Banner;
	private bannerAt = 0;

	// screencast
	private sink?: FrameSink;
	private cast?: {
		page: Page;
		cdp: CDPSession;
		width: number;
		quality: number;
		onFrame: (ev: ScreencastFrame) => void;
	};
	private want?: { width: number; quality: number };
	private seq = 0;
	private acked = 0;
	private lastSent = 0;
	private latest?: Frame;
	private ackTimer?: NodeJS.Timeout;
	private viewerTimer?: NodeJS.Timeout;
	private followTimer?: NodeJS.Timeout;
	private bucket = { at: Date.now(), n: 0 };
	private heldButtons = 0;
	private touchOn?: CDPSession;

	constructor(host: LiveHost, options: LiveOptions) {
		this.host = host;
		this.options = options;
		if (options.banner) this.banner = new Banner(this);
	}

	// ---- control ---------------------------------------------------------------------------

	get paused(): boolean {
		return this.state.controller === "user";
	}

	control(): ControlState {
		return { ...this.state };
	}

	/** The user takes the page. Idempotent. */
	takeover(source: "cerea" | "banner"): ControlState {
		if (this.state.controller !== "user") {
			this.state = { controller: "user", source, since: Date.now() };
			void this.banner?.refresh(this.host);
		}
		this.host.touch();
		return this.control();
	}

	/** The agent gets the page back. Idempotent. */
	handback(): ControlState {
		if (this.state.controller !== "agent") {
			this.state = { controller: "agent" };
			void this.releaseInput();
			void this.banner?.refresh(this.host);
		}
		this.host.touch();
		return this.control();
	}

	/** The task ended: control returns, the cast stops, the banner goes. */
	async taskEnded(): Promise<void> {
		this.state = { controller: "agent" };
		await this.stopScreencast();
		await this.banner?.refresh(this.host);
	}

	/** Puts the bar back or takes it away as the task's pages changed; cheap to call often. */
	refreshBanner(): void {
		if (!this.banner || Date.now() - this.bannerAt < 250) return;
		this.bannerAt = Date.now();
		void this.banner.refresh(this.host);
	}

	/** Pages the banner is on at the moment: for tests. */
	bannerHostSelector(): string | undefined {
		return this.banner?.hostSelector;
	}

	async installBanner(page: Page): Promise<void> {
		await this.banner?.install(page, this.host);
	}

	// ---- screencast ------------------------------------------------------------------------

	setSink(sink: FrameSink | undefined): void {
		this.sink = sink;
		if (!sink) void this.stopScreencast();
	}

	get casting(): boolean {
		return this.cast !== undefined;
	}

	/**
	 * Starts the cast, or (called again) keeps it alive and adjusts it: `width` is what the viewer
	 * can show, so a small card gets small frames and a full screen view bigger ones.
	 */
	async startScreencast(request: { width?: number; quality?: number }): Promise<void> {
		if (!this.sink) {
			throw new ToolError(
				"This runtime cannot stream frames: it was not started over stdio by galopin."
			);
		}
		const width = Math.round(
			Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, finite(request.width, 10_000) ? request.width : 640))
		);
		const quality = Math.round(
			Math.min(90, Math.max(30, finite(request.quality, 100) ? request.quality : 60))
		);
		this.want = { width, quality };
		this.heartbeat();
		const page = this.host.activePage();
		if (!page) return; // started when a page appears (the follow timer)
		await this.castOn(page);
		this.followTimer ??= setInterval(() => void this.follow(), 1_000);
		this.followTimer.unref();
	}

	/** The viewer shows frames up to `seq`: credit for more, and proof it is still there. */
	ackFrame(seq: number): void {
		if (Number.isFinite(seq) && seq > this.acked) this.acked = Math.min(seq, this.seq);
		this.heartbeat();
		this.flush();
	}

	async stopScreencast(): Promise<void> {
		clearInterval(this.followTimer);
		clearTimeout(this.viewerTimer);
		clearTimeout(this.ackTimer);
		this.followTimer = this.viewerTimer = this.ackTimer = undefined;
		this.want = undefined;
		this.latest = undefined;
		const cast = this.cast;
		this.cast = undefined;
		if (cast) {
			cast.cdp.off("Page.screencastFrame", cast.onFrame);
			await cast.cdp.send("Page.stopScreencast").catch(() => {});
		}
	}

	private heartbeat(): void {
		clearTimeout(this.viewerTimer);
		this.viewerTimer = setTimeout(
			() => void this.stopScreencast(),
			this.options.viewerTimeoutMs ?? 25_000
		);
		this.viewerTimer.unref();
	}

	private async follow(): Promise<void> {
		if (!this.want) return;
		const page = this.host.activePage();
		if (page && (!this.cast || this.cast.page !== page || this.cast.page.isClosed())) {
			await this.castOn(page).catch(() => {});
		}
	}

	private async castOn(page: Page): Promise<void> {
		const want = this.want;
		if (!want) return;
		const current = this.cast;
		if (
			current &&
			current.page === page &&
			current.width === want.width &&
			current.quality === want.quality
		) {
			return;
		}
		if (current) {
			current.cdp.off("Page.screencastFrame", current.onFrame);
			await current.cdp.send("Page.stopScreencast").catch(() => {});
			this.cast = undefined;
		}
		const cdp = await this.cdpFor(page);
		const onFrame = (ev: ScreencastFrame) => this.onFrame(ev, cdp);
		cdp.on("Page.screencastFrame", onFrame);
		this.cast = { page, cdp, width: want.width, quality: want.quality, onFrame };
		await cdp.send("Page.startScreencast", {
			format: "jpeg",
			quality: want.quality,
			maxWidth: want.width,
			maxHeight: Math.round(want.width * 1.5),
			everyNthFrame: 1,
		});
	}

	private onFrame(ev: ScreencastFrame, cdp: CDPSession): void {
		const meta = ev.metadata;
		const frame: Frame = {
			seq: ++this.seq,
			width: Math.round(meta?.deviceWidth || 0),
			height: Math.round(meta?.deviceHeight || 0),
			mime: "image/jpeg",
			data: ev.data,
		};
		this.latest = frame;
		this.flush();
		// Chromium sends the next frame once this one is acked; the pause keeps a busy page to
		// a dozen frames a second at most.
		const wait = this.options.minFrameMs ?? 80;
		setTimeout(
			() => void cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {}),
			wait
		).unref();
	}

	/** Sends the newest frame if the viewer has credit; an older waiting frame is simply dropped. */
	private flush(): void {
		const frame = this.latest;
		if (!frame || !this.sink) return;
		if (this.lastSent - this.acked >= (this.options.maxInFlight ?? 3)) return;
		this.latest = undefined;
		this.lastSent = frame.seq;
		try {
			this.sink(frame);
		} catch {
			// A sink that cannot send (the channel is closing) loses the frame: the next one follows.
		}
	}

	// ---- input -----------------------------------------------------------------------------

	/** Dispatches the user's events. Refused unless the user is in control. */
	async input(events: InputEvent[]): Promise<{ sent: number; dropped: number }> {
		if (!this.paused) {
			throw new ToolError("Input is accepted only while the user is in control (takeover first).");
		}
		const page = this.host.activePage();
		if (!page || page.isClosed()) throw new ToolError("There is no page to send input to.");
		this.host.touch();
		const cdp = await this.cdpFor(page);
		let sent = 0;
		let dropped = 0;
		for (const e of events) {
			if (!this.takeToken()) {
				dropped += 1;
				continue;
			}
			await this.dispatch(cdp, e);
			sent += 1;
		}
		return { sent, dropped };
	}

	private takeToken(): boolean {
		const now = Date.now();
		if (now - this.bucket.at >= 1_000) this.bucket = { at: now, n: 0 };
		this.bucket.n += 1;
		return this.bucket.n <= EVENTS_PER_SECOND;
	}

	private async dispatch(cdp: CDPSession, e: InputEvent): Promise<void> {
		switch (e.type) {
			case "mouse": {
				const bit = BUTTON_BITS[e.button ?? "left"];
				if (e.action === "down") this.heldButtons |= bit;
				if (e.action === "up") this.heldButtons &= ~bit;
				const type = (
					{
						move: "mouseMoved",
						down: "mousePressed",
						up: "mouseReleased",
						wheel: "mouseWheel",
					} as const
				)[e.action];
				await cdp.send("Input.dispatchMouseEvent", {
					type,
					x: e.x,
					y: e.y,
					button: e.action === "move" || e.action === "wheel" ? "none" : e.button,
					buttons: this.heldButtons,
					clickCount: e.action === "down" || e.action === "up" ? e.clickCount : 0,
					...(e.action === "wheel" ? { deltaX: e.deltaX, deltaY: e.deltaY } : {}),
					modifiers: e.modifiers ?? 0,
				});
				return;
			}
			case "touch": {
				// Chromium on a desktop does not deliver touch events to a page until touch is
				// emulated: it is switched on at the first touch and off when control returns.
				if (!this.touchOn) {
					this.touchOn = cdp;
					await cdp
						.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
						.catch(() => {});
				}
				const type = (
					{
						start: "touchStart",
						move: "touchMove",
						end: "touchEnd",
						cancel: "touchCancel",
					} as const
				)[e.action];
				await cdp.send("Input.dispatchTouchEvent", {
					type,
					touchPoints: e.points.map((p) => ({ x: p.x, y: p.y, id: p.id ?? 0 })),
					modifiers: e.modifiers ?? 0,
				});
				return;
			}
			case "key": {
				const info = SPECIAL_KEYS[e.key]!;
				const text = e.key === "Enter" ? "\r" : undefined;
				await cdp.send("Input.dispatchKeyEvent", {
					type: e.action === "down" ? (text ? "keyDown" : "rawKeyDown") : "keyUp",
					key: e.key,
					code: info.code,
					windowsVirtualKeyCode: info.vk,
					nativeVirtualKeyCode: info.vk,
					modifiers: e.modifiers ?? 0,
					...(e.action === "down" && text ? { text, unmodifiedText: text } : {}),
				});
				return;
			}
			case "text":
				// What a keyboard, an IME or a paste produced: the page sees it as typed.
				await cdp.send("Input.insertText", { text: e.text });
				return;
		}
	}

	/** A button held when control returns would stay down in the page. */
	private async releaseInput(): Promise<void> {
		const touch = this.touchOn;
		this.touchOn = undefined;
		await touch?.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
		if (this.heldButtons === 0) return;
		const page = this.host.activePage();
		this.heldButtons = 0;
		if (!page || page.isClosed()) return;
		const cdp = await this.cdpFor(page).catch(() => undefined);
		await cdp
			?.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: "left" })
			.catch(() => {});
	}

	cdpFor(page: Page): Promise<CDPSession> {
		let cdp = this.cdps.get(page);
		if (!cdp) {
			const context = this.host.context();
			if (!context) return Promise.reject(new ToolError("The browser is not running."));
			cdp = context.newCDPSession(page);
			this.cdps.set(page, cdp);
			cdp.catch(() => this.cdps.delete(page));
		}
		return cdp;
	}

	/** What a screenshot must hide: the banner. */
	screenshotStyle(): string | undefined {
		return this.banner?.hideCss;
	}
}

interface ScreencastFrame {
	data: string;
	sessionId: number;
	metadata?: { deviceWidth?: number; deviceHeight?: number };
}

// ---- the banner ---------------------------------------------------------------------------

/**
&
 * control, "You are in control · Hand back".
 *
 * Why a page cannot reach it:
 * - It runs in an **isolated world** (a script made with `worldName`): the page's own scripts do
 *   not see its variables or functions, and the binding that tells the runtime about a click is
 *   exposed to that world only (`Runtime.addBinding` with `executionContextName`), so no page
 *   script can call it.
 * - The bar sits in a **closed shadow root** on an element with a random attribute, in the top
 *   layer (a manual popover), and acts only on a click with `isTrusted`, which a script cannot
 *   forge. A script can hide or remove the bar, which only takes the user's shortcut away.
 * - It is invisible to the agent: it has no text in the page's tree (a closed shadow root is
 *   not traversed, so the AI snapshot and `extract` do not contain it), and screenshots hide its
 *   host (`hideCss`). The binding can only pause the agent or give control back, never act.
 */
class Banner {
	private readonly world = `cerea-${randomBytes(6).toString("hex")}`;
	private readonly binding = `__cerea_${randomBytes(6).toString("hex")}`;
	private readonly attr = `data-cb-${randomBytes(6).toString("hex")}`;
	private readonly pages = new Map<Page, { cdp: CDPSession; contexts: Set<number> }>();
	readonly hostSelector = `[${this.attr}]`;
	readonly hideCss = `${this.hostSelector}{visibility:hidden!important;display:none!important}`;

	private readonly live: LiveView;

	constructor(live: LiveView) {
		this.live = live;
	}

	async install(page: Page, host: LiveHost): Promise<void> {
		if (this.pages.has(page)) return;
		const entry = { cdp: undefined as unknown as CDPSession, contexts: new Set<number>() };
		this.pages.set(page, entry);
		page.once("close", () => this.pages.delete(page));
		try {
			const context = host.context();
			if (!context) return;
			const cdp = await context.newCDPSession(page);
			entry.cdp = cdp;
			cdp.on("Runtime.executionContextCreated", (ev: { context: ContextInfo }) => {
				if (ev.context.name !== this.world || ev.context.auxData?.isDefault !== false) return;
				entry.contexts.add(ev.context.id);
				void this.apply(page, entry, ev.context.id, host);
			});
			cdp.on("Runtime.executionContextDestroyed", (ev: { executionContextId: number }) => {
				entry.contexts.delete(ev.executionContextId);
			});
			cdp.on("Runtime.executionContextsCleared", () => entry.contexts.clear());
			cdp.on("Runtime.bindingCalled", (ev: { name: string; payload: string }) => {
				if (ev.name !== this.binding) return;
				this.onClick(ev.payload);
			});
			await cdp.send("Runtime.enable");
			await cdp.send("Runtime.addBinding", {
				name: this.binding,
				executionContextName: this.world,
			});
			await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
				source: this.script(),
				worldName: this.world,
				runImmediately: true,
			});
		} catch {
			// A page that closed while the banner was going in just has none.
		}
	}

	private onClick(payload: string): void {
		let action: unknown;
		try {
			action = (JSON.parse(payload) as { a?: unknown }).a;
		} catch {
			return;
		}
		if (action === "takeover") this.live.takeover("banner");
		else if (action === "handback") this.live.handback();
	}

	/** Shows the right bar (or none) on every page. */
	async refresh(host: LiveHost): Promise<void> {
		const task = new Set(host.taskPages());
		await Promise.all(
			[...this.pages].map(async ([page, entry]) => {
				for (const id of entry.contexts) await this.apply(page, entry, id, host, task);
			})
		);
	}

	private async apply(
		page: Page,
		entry: { cdp: CDPSession },
		contextId: number,
		host: LiveHost,
		task = new Set(host.taskPages())
	): Promise<void> {
		const mode = !task.has(page) ? "off" : this.live.paused ? "user" : "agent";
		// The world's context exists a moment before its script has run: try again shortly.
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const done = await entry.cdp
				.send("Runtime.evaluate", {
					contextId,
					expression: `typeof globalThis.__ceraBanner === "function" && (globalThis.__ceraBanner(${JSON.stringify(mode)}), true)`,
					returnByValue: true,
				})
				.then((r) => (r as { result?: { value?: unknown } }).result?.value === true)
				.catch(() => true);
			if (done) return;
			await new Promise((r) => setTimeout(r, 40));
		}
	}

	/** The script of the isolated world. `__ceraBanner(mode)` is called by the runtime only. */
	private script(): string {
		return `(() => {
	if (globalThis.__ceraBanner) return;
	const text = {
		agent: ["Cerea is using this window", "Take over", "takeover"],
		user: ["You are in control", "Hand back", "handback"],
	};
	let host = null;
	const build = (mode) => {
		if (!host || !host.isConnected) {
			host = document.createElement("div");
			host.setAttribute(${JSON.stringify(this.attr)}, "");
			host.setAttribute("popover", "manual");
			host.style.cssText = "position:fixed!important;inset:auto auto 12px 50%!important;transform:translateX(-50%)!important;margin:0!important;border:0!important;padding:0!important;background:transparent!important;overflow:visible!important;z-index:2147483647!important;";
			const root = host.attachShadow({ mode: "closed" });
			root.innerHTML = '<style>.b{font:13px/1.2 system-ui,sans-serif;display:flex;align-items:center;gap:10px;background:#1f2937;color:#fff;border-radius:999px;padding:6px 6px 6px 14px;box-shadow:0 2px 10px rgba(0,0,0,.35)}button{font:inherit;cursor:pointer;border:0;border-radius:999px;padding:5px 12px;background:#fff;color:#111827}</style><div class="b"><span></span><button type="button"></button></div>';
			const span = root.querySelector("span");
			const button = root.querySelector("button");
			host.__set = (m) => { span.textContent = text[m][0]; button.textContent = text[m][1]; button.dataset.a = text[m][2]; };
			button.addEventListener("click", (ev) => {
				if (!ev.isTrusted) return;
				const call = globalThis[${JSON.stringify(this.binding)}];
				if (typeof call === "function") call(JSON.stringify({ a: button.dataset.a }));
			}, true);
			(document.body || document.documentElement).appendChild(host);
			try { host.showPopover(); } catch {}
		}
		host.__set(mode);
	};
	globalThis.__ceraBanner = (mode) => {
		if (mode === "off") { if (host) host.remove(); host = null; return; }
		if (!document.documentElement) return;
		build(mode);
	};
})();`;
	}
}

interface ContextInfo {
	id: number;
	name: string;
	auxData?: { isDefault?: boolean; frameId?: string };
}
