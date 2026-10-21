import CodeTerminal from "./CodeTerminal.svelte";
import { render } from "vitest-browser-svelte";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { BIN_TERM_INPUT, decodeTerminalFrame } from "$lib/utils/terminalBinary";

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
	constructor() {
		FakeWebSocket.constructed += 1;
	}
	readyState = FakeWebSocket.OPEN;
	binaryType = "arraybuffer";
	addEventListener(_type: string, _listener: EventListenerOrEventListenerObject): void {
		/* handlers are recorded nowhere and never fire: no open, no close, no
		 * message — the component cannot be knocked into a reconnect here */
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
