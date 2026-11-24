import CodeTerminal from "./CodeTerminal.svelte";
import { render } from "vitest-browser-svelte";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
	BIN_TERM_INPUT,
	BIN_TERM_OUTPUT,
	decodeTerminalFrame,
	encodeTerminalFrame,
} from "$lib/utils/terminalBinary";

/**
 * The terminal's clipboard wiring, driven through a real xterm in Chromium.
 * The decision matrix itself is covered by the node spec
 * (`terminalKeys.spec.ts`); what a matrix alone cannot prove is that the
 * wiring actually sits between the keyboard and the shell — so every
 * assertion here rides the frames the component puts on its socket.
 *
 * The socket is a stub that records `send` and never opens: the component's
 * guards only ever read `readyState === WebSocket.OPEN`, which the stub
 * claims statically, so captured sends need no open event and nothing can
 * close or reconnect underneath a test. The recorded frames are read back
 * with the real binary decoder, exactly as the machine would.
 */
vi.mock("$lib/codeApi", () => ({
	mintTerminalTicket: vi.fn(async () => "ticket"),
	terminalSocketUrl: vi.fn(() => "ws://test/term"),
	TerminalReauthRequired: class TerminalReauthRequired extends Error {},
}));

class FakeWebSocket {
	static OPEN = 1;
	/** Every frame the component (any mounted instance) tried to send. */
	static sent: Array<string | Uint8Array> = [];
	/** How many sockets the component has constructed: it only assigns `ws`
	 * (which every send guards on) after the async ticket mint, so a test must
	 * wait for the socket, not just for xterm's DOM, before typing. */
	static constructed = 0;
	/** The latest socket's message listeners, so a test can deliver output. */
	static messageListeners: Array<(event: { data: unknown }) => void> = [];
	constructor() {
		FakeWebSocket.constructed += 1;
		FakeWebSocket.messageListeners = [];
	}
	readyState = FakeWebSocket.OPEN;
	binaryType = "arraybuffer";
	addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
		/* open and close never fire, so the component cannot be knocked into a
		 * reconnect here; only message listeners are kept, for `deliverOutput` */
		if (type === "message") {
			FakeWebSocket.messageListeners.push(
				listener as unknown as (event: { data: unknown }) => void
			);
		}
	}
	send(data: string | Uint8Array): void {
		FakeWebSocket.sent.push(data);
	}
	close(): void {}
}

/** The clipboard the component reads and writes, replaced wholesale: a
 * browser test holds no clipboard permission, and the fresh object each
 * beforeEach installs carries no call history between tests. */
const clipboard = {
	writeText: vi.fn(async (_text: string) => {}),
	readText: vi.fn(async () => "pasted text"),
};

/** The component loads xterm lazily, and the first test to mount it pays
 * for fetching those chunks from the dev server: under load that exceeds the
 * one second `vi.waitFor` allows for xterm's DOM to appear, failing whichever
 * test happens to run first. The imports are module-cached, so doing them once
 * here (under the hook's own, longer timeout) leaves every test a warm mount
 * and its waits measuring only the component's wiring. */
beforeAll(async () => {
	await Promise.all([
		import("@xterm/xterm"),
		import("@xterm/addon-fit"),
		import("@xterm/addon-unicode11"),
		import("@xterm/addon-web-links"),
		import("@xterm/xterm/css/xterm.css"),
	]);
}, 30_000);

beforeEach(() => {
	vi.stubGlobal("WebSocket", FakeWebSocket);
	Object.defineProperty(navigator, "clipboard", {
		value: clipboard,
		configurable: true,
	});
	clipboard.writeText.mockClear();
	clipboard.readText.mockClear();
	FakeWebSocket.sent.length = 0;
	FakeWebSocket.constructed = 0;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Renders the terminal and waits until it is really wired: xterm's own DOM
 * (the lazy import and `term.open()` complete inside the component's effect,
 * after the first paint) and then the socket, which the component creates
 * only after `mintTerminalTicket` resolves. Until then every send is
 * silently dropped, so a keystroke typed earlier would vanish. */
async function mountTerminal() {
	const screen = render(CodeTerminal, { deviceId: "d1", terminalId: "t1" });
	await vi.waitFor(() => expect(screen.baseElement.querySelector(".xterm-screen")).toBeTruthy());
	await vi.waitFor(() => expect(FakeWebSocket.constructed).toBe(1));
	return screen;
}

function helperTextarea(base: HTMLElement): HTMLTextAreaElement {
	const el = base.querySelector(".xterm-helper-textarea");
	if (!(el instanceof HTMLTextAreaElement)) throw new Error("xterm's helper textarea not found");
	return el;
}

interface Chord {
	key: string;
	/** xterm's key evaluation still consults the legacy keyCode, which a
	 * synthetic KeyboardEvent leaves at 0 — patched onto the instance after
	 * construction (67 "c", 86 "v"). */
	keyCode: number;
	ctrl?: boolean;
	shift?: boolean;
}

function pressKey(target: HTMLTextAreaElement, chord: Chord): KeyboardEvent {
	// cancelable like a real keydown, so a handler's preventDefault shows up
	// as `defaultPrevented` afterwards.
	const ev = new KeyboardEvent("keydown", {
		key: chord.key,
		ctrlKey: chord.ctrl ?? false,
		shiftKey: chord.shift ?? false,
		bubbles: true,
		cancelable: true,
	});
	Object.defineProperty(ev, "keyCode", { get: () => chord.keyCode });
	target.dispatchEvent(ev);
	return ev;
}

/** The text carried by the BIN_TERM_INPUT frames sent since index `from`.
 * Only input frames count, deliberately: the component also puts JSON
 * control messages on the same socket (a resize, fired asynchronously by
 * the ResizeObserver), and those are not keystrokes. */
function inputTextsSince(from: number): string[] {
	const texts: string[] = [];
	for (const raw of FakeWebSocket.sent.slice(from)) {
		if (!(raw instanceof Uint8Array)) continue;
		const frame = decodeTerminalFrame(raw.buffer as ArrayBuffer);
		if (frame?.kind === BIN_TERM_INPUT) texts.push(new TextDecoder().decode(frame.payload));
	}
	return texts;
}

describe("CodeTerminal clipboard wiring", () => {
	it("Ctrl+C with nothing selected still reaches the shell as SIGINT", async () => {
		const screen = await mountTerminal();
		const before = FakeWebSocket.sent.length;
		pressKey(helperTextarea(screen.baseElement), { key: "c", keyCode: 67, ctrl: true });
		await vi.waitFor(() => expect(inputTextsSince(before)).toEqual(["\x03"]));
	});

	it("Ctrl+V lets the browser paste instead of sending ^V", async () => {
		const screen = await mountTerminal();
		const textarea = helperTextarea(screen.baseElement);
		const before = FakeWebSocket.sent.length;
		pressKey(textarea, { key: "v", keyCode: 86, ctrl: true });
		// The ^V byte xterm would have sent on its own is gone — the handler
		// stepped aside, and the keydown did nothing to the shell.
		expect(inputTextsSince(before)).toEqual([]);
		// What the step-aside was for: the paste event the browser now fires
		// (dispatched here by hand, carrying the clipboard's contents, since a
		// synthetic keydown cannot trigger a real paste) is read by xterm's own
		// listener and lands on the shell as ordinary input.
		const data = new DataTransfer();
		data.setData("text/plain", "hello");
		textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
		await vi.waitFor(() => expect(inputTextsSince(before)).toEqual(["hello"]));
	});

	it("Ctrl+Shift+C consumes the DevTools chord and copies nothing without a selection", async () => {
		const screen = await mountTerminal();
		const before = FakeWebSocket.sent.length;
		const ev = pressKey(helperTextarea(screen.baseElement), {
			key: "c",
			keyCode: 67,
			ctrl: true,
			shift: true,
		});
		// Consumed, not stepped aside for: the chord must not fall through to
		// the browser's own Ctrl+Shift+C binding (DevTools).
		expect(ev.defaultPrevented).toBe(true);
		// With nothing selected there is nothing to write to the clipboard.
		expect(clipboard.writeText).not.toHaveBeenCalled();
		expect(inputTextsSince(before)).toEqual([]);
	});

	it("the mobile key bar's Paste key pastes the clipboard", async () => {
		// Before rendering: the key bar lives behind the mobile breakpoint,
		// which svelte/reactivity's MediaQuery reads through window.matchMedia.
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query.includes("639"),
			media: query,
			onchange: null,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
			dispatchEvent: () => false,
		}));
		const screen = await mountTerminal();
		const paste = screen.baseElement.querySelector('button[aria-label="Paste"]');
		if (!(paste instanceof HTMLButtonElement)) throw new Error("the key bar has no Paste key");
		const before = FakeWebSocket.sent.length;
		paste.click();
		// The read happened, and what came back from the clipboard went to the
		// shell as terminal input.
		await vi.waitFor(() => expect(inputTextsSince(before)).toEqual(["pasted text"]));
		expect(clipboard.readText).toHaveBeenCalled();
	});
});

/** Feeds bytes to the terminal as the machine's output frame would. */
let outputOffset = 0;
function deliverOutput(text: string): void {
	const payload = new TextEncoder().encode(text);
	const frame = encodeTerminalFrame({
		kind: BIN_TERM_OUTPUT,
		channel: "b",
		offset: outputOffset,
		payload,
	});
	outputOffset += payload.length;
	for (const l of FakeWebSocket.messageListeners) l({ data: frame.slice().buffer });
}

function touchSwipe(target: Element, fromY: number, toY: number, steps = 8): void {
	const rect = target.getBoundingClientRect();
	const x = rect.left + rect.width / 2;
	const fire = (type: string, y: number, ended = false) => {
		const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y });
		target.dispatchEvent(
			new TouchEvent(type, {
				touches: ended ? [] : [touch],
				changedTouches: [touch],
				bubbles: true,
				cancelable: true,
			})
		);
	};
	fire("touchstart", fromY);
	for (let i = 1; i <= steps; i++) fire("touchmove", fromY + ((toY - fromY) * i) / steps);
	fire("touchend", toY, true);
}

function viewport(base: HTMLElement): HTMLElement {
	const el = base.querySelector(".xterm-screen");
	if (!(el instanceof HTMLElement)) throw new Error("xterm screen not found");
	return el;
}

describe("CodeTerminal touch scrolling", () => {
	const lines = Array.from({ length: 300 }, (_, i) => `line ${i}\r\n`).join("");

	it("a downward swipe scrolls into the scrollback and shows jump-to-bottom, which returns", async () => {
		const screen = await mountTerminal();
		deliverOutput(lines);
		// Following the live bottom: no button yet.
		await new Promise((r) => setTimeout(r, 100));
		expect(screen.baseElement.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull();
		const el = viewport(screen.baseElement);
		const rect = el.getBoundingClientRect();
		touchSwipe(el, rect.top + 20, rect.top + 200);
		await vi.waitFor(() =>
			expect(
				screen.baseElement.querySelector('button[aria-label="Scroll to bottom"]')
			).not.toBeNull()
		);
		const btn = screen.baseElement.querySelector('button[aria-label="Scroll to bottom"]');
		(btn as HTMLButtonElement).click();
		await vi.waitFor(() =>
			expect(screen.baseElement.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
		);
	});

	it("a swipe on the alternate screen sends wheel input to the app instead", async () => {
		const screen = await mountTerminal();
		// Alternate screen with SGR mouse tracking, as vim or tmux request it.
		deliverOutput("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
		await new Promise((r) => setTimeout(r, 100));
		const before = FakeWebSocket.sent.length;
		const el = viewport(screen.baseElement);
		const rect = el.getBoundingClientRect();
		touchSwipe(el, rect.top + 20, rect.top + 200);
		await vi.waitFor(() => {
			const texts = inputTextsSince(before);
			expect(texts.length).toBeGreaterThan(0);
			// Finger down = content down = wheel up (button 64).
			expect(texts.every((t) => t.startsWith("\x1b[<64;"))).toBe(true);
		});
		// And the page-level scrollback button never appears on the alt screen.
		expect(screen.baseElement.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull();
	});
});

describe("CodeTerminal tap to type", () => {
	function stubNarrow(): void {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query.includes("639"),
			media: query,
			onchange: null,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
			dispatchEvent: () => false,
		}));
	}

	function pointer(target: Element, type: string, x: number, y: number, timeStamp?: number): void {
		const ev = new PointerEvent(type, {
			pointerId: 1,
			isPrimary: true,
			pointerType: "touch",
			clientX: x,
			clientY: y,
			bubbles: true,
			cancelable: true,
		});
		if (timeStamp !== undefined) Object.defineProperty(ev, "timeStamp", { value: timeStamp });
		target.dispatchEvent(ev);
	}

	it("a tap focuses the textarea", async () => {
		stubNarrow();
		const screen = await mountTerminal();
		const el = viewport(screen.baseElement);
		const r = el.getBoundingClientRect();
		const x = r.left + 20;
		const y = r.top + 20;
		pointer(el, "pointerdown", x, y, 1000);
		pointer(el, "pointerup", x + 2, y + 1, 1100);
		expect(document.activeElement).toBe(helperTextarea(screen.baseElement));
	});

	it("a drag does not focus", async () => {
		stubNarrow();
		const screen = await mountTerminal();
		const el = viewport(screen.baseElement);
		const r = el.getBoundingClientRect();
		const x = r.left + 20;
		const y = r.top + 20;
		pointer(el, "pointerdown", x, y, 1000);
		pointer(el, "pointermove", x, y + 40, 1050);
		pointer(el, "pointerup", x, y + 40, 1100);
		expect(document.activeElement).not.toBe(helperTextarea(screen.baseElement));
	});

	it("a long press does not focus", async () => {
		stubNarrow();
		const screen = await mountTerminal();
		const el = viewport(screen.baseElement);
		const r = el.getBoundingClientRect();
		pointer(el, "pointerdown", r.left + 20, r.top + 20, 1000);
		pointer(el, "pointerup", r.left + 20, r.top + 20, 1700);
		expect(document.activeElement).not.toBe(helperTextarea(screen.baseElement));
	});

	it("the key row has no Type or Done key, and a special key sends without focusing", async () => {
		stubNarrow();
		const screen = await mountTerminal();
		expect(screen.baseElement.querySelector('button[aria-label="Type"]')).toBeNull();
		expect(screen.baseElement.querySelector('button[aria-label="Done"]')).toBeNull();
		const esc = screen.baseElement.querySelector('button[aria-label="Escape"]');
		const tab = esc ?? screen.baseElement.querySelector('button[aria-label="Tab"]');
		if (!(tab instanceof HTMLButtonElement)) throw new Error("no special key found");
		const before = FakeWebSocket.sent.length;
		tab.click();
		await vi.waitFor(() => expect(inputTextsSince(before).length).toBe(1));
		expect(document.activeElement).not.toBe(helperTextarea(screen.baseElement));
	});
});

describe("CodeTerminal copy view", () => {
	function button(base: HTMLElement, label: string): HTMLButtonElement {
		const el = base.querySelector(`button[aria-label="${label}"]`);
		if (!(el instanceof HTMLButtonElement)) throw new Error(`no button "${label}"`);
		return el;
	}
	function buttonByText(base: HTMLElement, text: string): HTMLButtonElement {
		const el = [...base.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
		if (!el) throw new Error(`no button with text "${text}"`);
		return el;
	}

	/** The test browser's own viewport can be narrower than the breakpoint. */
	function stubViewport(narrow: boolean): void {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: narrow && query.includes("639"),
			media: query,
			onchange: null,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
			dispatchEvent: () => false,
		}));
	}

	async function mountWithOutput(narrow = false) {
		stubViewport(narrow);
		const screen = await mountTerminal();
		deliverOutput(
			"\x1b[31mred\x1b[0m line one   \r\nsecond\r\n" + "x".repeat(200) + "\r\nlast\r\n"
		);
		await vi.waitFor(() => expect(screen.baseElement.textContent).toContain("last"));
		return screen;
	}

	it("Select text shows the buffer as plain text, ANSI stripped and wrapped rows joined", async () => {
		const screen = await mountWithOutput();
		button(screen.baseElement, "Select text").click();
		const pre = await vi.waitFor(() => {
			const el = screen.baseElement.querySelector('[data-testid="terminal-copy-text"]');
			if (!el) throw new Error("overlay not open");
			return el as HTMLElement;
		});
		expect(pre.textContent).toBe(`red line one\nsecond\n${"x".repeat(200)}\nlast`);
		expect(getComputedStyle(pre).userSelect).toBe("text");
	});

	it("Copy all writes the whole text to the clipboard and says so; Close removes the overlay", async () => {
		const screen = await mountWithOutput();
		button(screen.baseElement, "Select text").click();
		await vi.waitFor(() => buttonByText(screen.baseElement, "Copy all"));
		buttonByText(screen.baseElement, "Copy all").click();
		await vi.waitFor(() =>
			expect(clipboard.writeText).toHaveBeenCalledWith(
				`red line one\nsecond\n${"x".repeat(200)}\nlast`
			)
		);
		await vi.waitFor(() => expect(screen.baseElement.textContent).toContain("Copied"));
		button(screen.baseElement, "Close text view").click();
		await vi.waitFor(() =>
			expect(screen.baseElement.querySelector('[data-testid="terminal-copy-overlay"]')).toBeNull()
		);
	});

	it("falls back to execCommand when the async clipboard refuses", async () => {
		clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
		const exec = vi.fn(() => true);
		document.execCommand = exec as unknown as typeof document.execCommand;
		const screen = await mountWithOutput();
		button(screen.baseElement, "Select text").click();
		await vi.waitFor(() => buttonByText(screen.baseElement, "Copy all"));
		buttonByText(screen.baseElement, "Copy all").click();
		await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
		await vi.waitFor(() => expect(screen.baseElement.textContent).toContain("Copied"));
	});

	it("shows Copy selection only while xterm has a selection, and copies it", async () => {
		const screen = await mountWithOutput();
		expect(screen.baseElement.querySelector('[data-testid="terminal-copy-selection"]')).toBeNull();
		// A double-click selects a word through xterm's own mouse handling.
		const rows = screen.baseElement.querySelector(".xterm-screen") as HTMLElement;
		const r = rows.getBoundingClientRect();
		const opts = { bubbles: true, clientX: r.left + 3, clientY: r.top + 3, button: 0, buttons: 1 };
		rows.dispatchEvent(new MouseEvent("mousedown", { ...opts, detail: 2 }));
		document.dispatchEvent(new MouseEvent("mouseup", opts));
		const copy = await vi.waitFor(() => {
			const el = screen.baseElement.querySelector('[data-testid="terminal-copy-selection"]');
			if (!el) throw new Error("no Copy selection yet");
			return el as HTMLButtonElement;
		});
		copy.click();
		await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
		expect(String(clipboard.writeText.mock.calls[0][0]).length).toBeGreaterThan(0);
	});
	it("on desktop the Select text bar sits below the output and shows the Shift hint", async () => {
		const screen = await mountWithOutput();
		const select = screen.baseElement.querySelector('[data-testid="terminal-select-text"]');
		if (!select) throw new Error("no Select text button");
		const host = screen.baseElement.querySelector(".xterm") as HTMLElement;
		expect(select.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			host.getBoundingClientRect().bottom - 1
		);
		expect(screen.baseElement.textContent).toMatch(/(Shift|Option)\+drag selects/);
	});

	it("on a phone, Select and Copy live in the key bar and Copy waits for a selection", async () => {
		const screen = await mountWithOutput(true);
		const bar = screen.baseElement.querySelector('[role="toolbar"]') as HTMLElement;
		const select = bar.querySelector('[data-testid="terminal-select-text"]') as HTMLButtonElement;
		const copy = bar.querySelector('[data-testid="terminal-copy-selection"]') as HTMLButtonElement;
		expect(select).toBeTruthy();
		expect(copy.disabled).toBe(true);
		expect(screen.baseElement.querySelectorAll('[data-testid="terminal-select-text"]').length).toBe(
			1
		);
		select.click();
		await vi.waitFor(() =>
			expect(
				screen.baseElement.querySelector('[data-testid="terminal-copy-overlay"]')
			).not.toBeNull()
		);
	});
});

describe("CodeTerminal long-press selection on a phone", () => {
	function stubViewport(narrow: boolean): void {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: narrow && query.includes("639"),
			media: query,
			onchange: null,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
			dispatchEvent: () => false,
		}));
	}

	function pointer(target: Element, type: string, x: number, y: number): void {
		target.dispatchEvent(
			new PointerEvent(type, {
				pointerId: 1,
				isPrimary: true,
				pointerType: "touch",
				clientX: x,
				clientY: y,
				bubbles: true,
				cancelable: true,
			})
		);
	}

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	/** Client centre of cell (col, viewport row), from the screen's rect. */
	function cellCentre(base: HTMLElement, col: number, row: number) {
		const r = viewport(base).getBoundingClientRect();
		// The terminal fits its host, so the column count is not fixed: take the
		// cell width from xterm's own measure element (32 characters).
		const measure = base.querySelector(".xterm-char-measure-element");
		const cw = (measure?.getBoundingClientRect().width ?? 0) / 32;
		const lineH = r.height / base.querySelectorAll(".xterm-rows > div").length;
		return { x: r.left + (col + 0.5) * cw, y: r.top + (row + 0.5) * lineH, cw, lineH };
	}

	async function mountPhone() {
		stubViewport(true);
		const screen = await mountTerminal();
		deliverOutput("alpha bravo charlie\r\nsecond line here\r\nthird\r\n");
		await vi.waitFor(() => expect(screen.baseElement.textContent).toContain("third"));
		return screen;
	}

	async function longPress(base: HTMLElement, col: number, row: number) {
		const el = viewport(base);
		const { x, y } = cellCentre(base, col, row);
		pointer(el, "pointerdown", x, y);
		await sleep(550);
		pointer(el, "pointerup", x, y);
	}

	const handle = (base: HTMLElement, role: "start" | "end") =>
		base.querySelector(`[data-testid="terminal-handle-${role}"]`) as HTMLElement | null;

	function copyKeyEnabled(base: HTMLElement): boolean {
		return !(base.querySelector('[data-testid="terminal-copy-selection"]') as HTMLButtonElement)
			.disabled;
	}

	it("a long press selects the word under the finger, shows handles and a menu, and does not type", async () => {
		const screen = await mountPhone();
		await longPress(screen.baseElement, 8, 0); // "bravo"
		await vi.waitFor(() =>
			expect(
				screen.baseElement.querySelector('[data-testid="terminal-selection-menu"]')
			).toBeTruthy()
		);
		expect(handle(screen.baseElement, "start")).toBeTruthy();
		expect(handle(screen.baseElement, "end")).toBeTruthy();
		expect(document.activeElement).not.toBe(helperTextarea(screen.baseElement));
		expect(copyKeyEnabled(screen.baseElement)).toBe(true);
	});

	it("a short tap still focuses the textarea and selects nothing", async () => {
		const screen = await mountPhone();
		const el = viewport(screen.baseElement);
		const { x, y } = cellCentre(screen.baseElement, 8, 0);
		pointer(el, "pointerdown", x, y);
		pointer(el, "pointerup", x, y);
		await sleep(550);
		expect(document.activeElement).toBe(helperTextarea(screen.baseElement));
		expect(screen.baseElement.querySelector('[data-testid="terminal-selection"]')).toBeNull();
	});

	it("a moving touch does not select", async () => {
		const screen = await mountPhone();
		const el = viewport(screen.baseElement);
		const { x, y } = cellCentre(screen.baseElement, 8, 0);
		pointer(el, "pointerdown", x, y);
		pointer(el, "pointermove", x, y + 30);
		await sleep(550);
		pointer(el, "pointerup", x, y + 30);
		expect(screen.baseElement.querySelector('[data-testid="terminal-selection"]')).toBeNull();
	});

	it("dragging the end handle extends the selection, across lines", async () => {
		const screen = await mountPhone();
		await longPress(screen.baseElement, 8, 0);
		const end = await vi.waitFor(() => {
			const h = handle(screen.baseElement, "end");
			expect(h).toBeTruthy();
			return h as HTMLElement;
		});
		const hr = end.getBoundingClientRect();
		const hx = hr.left + hr.width / 2;
		const hy = hr.top + hr.height / 2;
		const target = cellCentre(screen.baseElement, 5, 1);
		const grabOffset = hy - cellCentre(screen.baseElement, 12, 0).y;
		const fire = (type: string, x: number, y: number) =>
			end.dispatchEvent(
				new PointerEvent(type, {
					pointerId: 2,
					clientX: x,
					clientY: y,
					bubbles: true,
					cancelable: true,
				})
			);
		fire("pointerdown", hx, hy);
		fire("pointermove", target.x, target.y + grabOffset);
		fire("pointerup", target.x, target.y + grabOffset);
		await vi.waitFor(() => expect(handle(screen.baseElement, "end")).toBeTruthy());
		(
			screen.baseElement.querySelector('[data-testid="terminal-selection-copy"]') as HTMLElement
		).click();
		await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
		const text = clipboard.writeText.mock.calls[0][0];
		expect(text.startsWith("bravo charlie")).toBe(true);
		expect(text).toContain("second");
		expect(text).not.toContain("alpha");
	});

	it("Copy writes the selection to the clipboard and exits selection mode", async () => {
		const screen = await mountPhone();
		await longPress(screen.baseElement, 8, 0);
		const copy = await vi.waitFor(() => {
			const b = screen.baseElement.querySelector('[data-testid="terminal-selection-copy"]');
			expect(b).toBeTruthy();
			return b as HTMLButtonElement;
		});
		copy.click();
		await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("bravo"));
		await vi.waitFor(() =>
			expect(screen.baseElement.querySelector('[data-testid="terminal-selection"]')).toBeNull()
		);
	});

	it("Select all selects the scrollback too", async () => {
		const screen = await mountPhone();
		await longPress(screen.baseElement, 8, 0);
		const all = await vi.waitFor(() => {
			const b = screen.baseElement.querySelector('[data-testid="terminal-selection-all"]');
			expect(b).toBeTruthy();
			return b as HTMLButtonElement;
		});
		all.click();
		(
			screen.baseElement.querySelector('[data-testid="terminal-selection-copy"]') as HTMLElement
		).click();
		await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
		const text = clipboard.writeText.mock.calls[0][0];
		expect(text).toContain("alpha bravo charlie");
		expect(text).toContain("third");
	});

	it("tapping outside clears the selection, and the next tap types again", async () => {
		const screen = await mountPhone();
		await longPress(screen.baseElement, 8, 0);
		await vi.waitFor(() =>
			expect(screen.baseElement.querySelector('[data-testid="terminal-selection"]')).toBeTruthy()
		);
		const el = viewport(screen.baseElement);
		const { x, y } = cellCentre(screen.baseElement, 30, 10);
		pointer(el, "pointerdown", x, y);
		pointer(el, "pointerup", x, y);
		await vi.waitFor(() =>
			expect(screen.baseElement.querySelector('[data-testid="terminal-selection"]')).toBeNull()
		);
		expect(copyKeyEnabled(screen.baseElement)).toBe(false);
		expect(document.activeElement).not.toBe(helperTextarea(screen.baseElement));
		pointer(el, "pointerdown", x, y);
		pointer(el, "pointerup", x, y);
		expect(document.activeElement).toBe(helperTextarea(screen.baseElement));
	});

	it("selects with xterm directly while the app uses the mouse", async () => {
		const screen = await mountPhone();
		deliverOutput("\x1b[?1000h\x1b[?1006h");
		await sleep(50);
		const before = FakeWebSocket.sent.length;
		await longPress(screen.baseElement, 8, 0);
		await vi.waitFor(() => expect(copyKeyEnabled(screen.baseElement)).toBe(true));
		expect(inputTextsSince(before)).toEqual([]);
	});

	it("on desktop a long press never shows handles or the menu", async () => {
		stubViewport(false);
		const screen = await mountTerminal();
		deliverOutput("alpha bravo\r\n");
		await vi.waitFor(() => expect(screen.baseElement.textContent).toContain("bravo"));
		await longPress(screen.baseElement, 8, 0);
		expect(screen.baseElement.querySelector('[data-testid="terminal-selection"]')).toBeNull();
		expect(handle(screen.baseElement, "start")).toBeNull();
	});
});
