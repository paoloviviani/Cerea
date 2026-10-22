import ChatInput from "./ChatInput.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writable, get } from "svelte/store";
import { flushSync } from "svelte";
import { error as errorToast } from "$lib/stores/errors";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

type Result = { isFinal: boolean; 0: { transcript: string } };

class FakeRecognition {
	static instances: FakeRecognition[] = [];
	lang = "";
	continuous = false;
	interimResults = false;
	onresult: ((e: { results: Result[] }) => void) | null = null;
	onerror: ((e: { error: string }) => void) | null = null;
	onend: (() => void) | null = null;
	started = false;
	stopped = false;
	aborted = false;
	constructor() {
		FakeRecognition.instances.push(this);
	}
	start() {
		this.started = true;
	}
	stop() {
		this.stopped = true;
	}
	abort() {
		this.aborted = true;
	}
	say(...parts: [string, boolean][]) {
		this.onresult?.({ results: parts.map(([t, f]) => ({ isFinal: f, 0: { transcript: t } })) });
	}
}

const last = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];
const settingsContext = new Map<string, unknown>([["settings", writable({ activeModel: "m" })]]);

function mount(props: Record<string, unknown> = {}, flags: Record<string, unknown> = {}) {
	return renderWithApp(
		ChatInput,
		{ placeholder: "Ask anything", ...props },
		{
			page: {
				params: {},
				data: { user: { username: "tester" }, loginEnabled: true, shared: false, ...flags },
			},
			context: settingsContext,
		}
	);
}

const textarea = () => document.querySelector("textarea") as HTMLTextAreaElement;
const maybeMic = () => document.querySelector<HTMLButtonElement>("button[aria-pressed]");
const mic = (): HTMLButtonElement => {
	const b = maybeMic();
	if (!b) throw new Error("no dictation button");
	return b;
};
const tick = () => new Promise((r) => setTimeout(r, 20));

/** Type like a person: fire the input event the browser would. */
function type(text: string) {
	const ta = textarea();
	ta.focus();
	ta.value = text;
	ta.setSelectionRange(text.length, text.length);
	ta.dispatchEvent(new Event("input", { bubbles: true }));
}

const w = window as unknown as Record<string, unknown>;

// Chromium ships its own webkitSpeechRecognition: assigning undefined shadows
// it, which `delete` would not.
const unsupport = () => {
	w.SpeechRecognition = undefined;
	w.webkitSpeechRecognition = undefined;
};

beforeEach(() => {
	unsupport();
	FakeRecognition.instances = [];
	errorToast.set(undefined);
});
afterEach(unsupport);

describe("ChatInput dictation", () => {
	it("hides the button when the browser has no recognition", async () => {
		mount();
		await tick();
		expect(maybeMic()).toBeNull();
	});

	it("shows it for the unprefixed and the webkit constructor", async () => {
		w.webkitSpeechRecognition = FakeRecognition;
		let screen = mount();
		await tick();
		expect(maybeMic()).not.toBeNull();
		screen.unmount();
		w.webkitSpeechRecognition = undefined;
		w.SpeechRecognition = FakeRecognition;
		screen = mount();
		await tick();
		expect(maybeMic()).not.toBeNull();
	});

	it("hides it while the composer is disabled", async () => {
		w.SpeechRecognition = FakeRecognition;
		mount({ disabled: true });
		await tick();
		expect(maybeMic()).toBeNull();
	});

	it("starts with the browser language and flips its aria state; click again stops", async () => {
		w.SpeechRecognition = FakeRecognition;
		mount();
		await tick();
		const b = mic();
		expect(b.getAttribute("aria-pressed")).toBe("false");
		expect(b.getAttribute("aria-label")).toBe("Start dictation");
		b.click();
		await tick();
		expect(last().started).toBe(true);
		expect(last().lang).toBe(navigator.language);
		expect(last().interimResults).toBe(true);
		expect(b.getAttribute("aria-pressed")).toBe("true");
		expect(b.getAttribute("aria-label")).toBe("Stop dictation");
		b.click();
		await tick();
		expect(last().stopped).toBe(true);
		expect(b.getAttribute("aria-pressed")).toBe("false");
		expect(b.getAttribute("aria-label")).toBe("Start dictation");
	});

	it("shows interim text live, replaces it by the final, and keeps typed text", async () => {
		w.SpeechRecognition = FakeRecognition;
		mount();
		await tick();
		type("Dear team,");
		mic().click();
		await tick();
		last().say(["hello", false]);
		await tick();
		expect(textarea().value).toBe("Dear team, hello");
		last().say(["hello there", true], [" and more", false]);
		await tick();
		expect(textarea().value).toBe("Dear team, hello there and more");
		last().say(["hello there", true], [" and more", true]);
		await tick();
		expect(textarea().value).toBe("Dear team, hello there and more");
	});

	it("inserts at the caret, not the end", async () => {
		w.SpeechRecognition = FakeRecognition;
		mount();
		await tick();
		type("one three");
		textarea().setSelectionRange(3, 3);
		mic().click();
		await tick();
		last().say(["two", true]);
		await tick();
		expect(textarea().value).toBe("one two three");
	});

	it("typing ends the session so a late result cannot overwrite it", async () => {
		w.SpeechRecognition = FakeRecognition;
		mount();
		await tick();
		mic().click();
		await tick();
		const rec = last();
		rec.say(["hello", false]);
		await tick();
		type("hello world");
		await tick();
		expect(rec.aborted).toBe(true);
		expect(mic().getAttribute("aria-pressed")).toBe("false");
		rec.say(["hello again", true]);
		await tick();
		expect(textarea().value).toBe("hello world");
	});

	it("stops on send (Enter) and never submits by itself", async () => {
		w.SpeechRecognition = FakeRecognition;
		const onsubmit = vi.fn();
		mount({ onsubmit });
		await tick();
		mic().click();
		await tick();
		last().say(["send this", true]);
		await tick();
		expect(onsubmit).not.toHaveBeenCalled();
		textarea().focus();
		textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await tick();
		expect(onsubmit).toHaveBeenCalledTimes(1);
		expect(last().aborted).toBe(true);
		expect(mic().getAttribute("aria-pressed")).toBe("false");
	});

	it("stops when the draft is cleared from outside (a send button)", async () => {
		w.SpeechRecognition = FakeRecognition;
		const screen = mount({ value: "" });
		await tick();
		mic().click();
		await tick();
		last().say(["hi", false]);
		await tick();
		await screen.rerender({ value: "" });
		flushSync();
		await tick();
		expect(last().aborted).toBe(true);
	});

	it("stops when focus leaves the composer, but not when it moves to the mic", async () => {
		w.SpeechRecognition = FakeRecognition;
		mount();
		await tick();
		textarea().focus();
		mic().click();
		await tick();
		mic().focus();
		await tick();
		expect(last().aborted).toBe(false);
		(document.activeElement as HTMLElement).blur();
		await tick();
		expect(last().aborted).toBe(true);
		expect(mic().getAttribute("aria-pressed")).toBe("false");
	});

	it("stops when the component unmounts", async () => {
		w.SpeechRecognition = FakeRecognition;
		const screen = mount();
		await tick();
		mic().click();
		await tick();
		screen.unmount();
		expect(last().aborted).toBe(true);
	});

	it("reports the end of a session", async () => {
		w.SpeechRecognition = FakeRecognition;
		mount();
		await tick();
		mic().click();
		await tick();
		last().onend?.();
		await tick();
		expect(mic().getAttribute("aria-pressed")).toBe("false");
	});

	for (const [code, fragment] of [
		["not-allowed", "microphone permission is blocked"],
		["service-not-allowed", "Siri or Dictation"],
		["no-speech", "No speech heard"],
		["network", "network connection"],
		["audio-capture", "No microphone"],
	] as const) {
		it(`says something short for ${code}`, async () => {
			w.SpeechRecognition = FakeRecognition;
			mount();
			await tick();
			mic().click();
			await tick();
			last().onerror?.({ error: code });
			last().onend?.();
			await tick();
			expect(get(errorToast)).toContain(fragment);
			expect(mic().getAttribute("aria-pressed")).toBe("false");
		});
	}

	it("says so when a session ends by itself without a result or an error", async () => {
		w.SpeechRecognition = FakeRecognition;
		mount();
		await tick();
		mic().click();
		await tick();
		expect(last().started).toBe(true);
		last().onend?.();
		await tick();
		expect(get(errorToast)).toContain("stopped before it heard anything");
	});

	it("stays quiet when the person stops it, or something was heard", async () => {
		w.SpeechRecognition = FakeRecognition;
		mount();
		await tick();
		mic().click();
		await tick();
		mic().click();
		last().onend?.();
		await tick();
		expect(get(errorToast)).toBeUndefined();
		mic().click();
		await tick();
		last().say(["hi", true]);
		last().onend?.();
		await tick();
		expect(get(errorToast)).toBeUndefined();
	});

	describe("Safari (prefixed constructor only)", () => {
		const track = { stop: vi.fn() };
		let getUserMedia: ReturnType<typeof vi.fn>;
		const mockMic = (impl: () => Promise<unknown>) => {
			getUserMedia = vi.fn(impl);
			Object.defineProperty(navigator, "mediaDevices", {
				configurable: true,
				value: { getUserMedia },
			});
		};
		afterEach(() => Reflect.deleteProperty(navigator, "mediaDevices"));

		it("asks for the microphone inside the click, then starts recognition", async () => {
			w.webkitSpeechRecognition = FakeRecognition;
			mockMic(async () => ({ getTracks: () => [track] }));
			mount();
			await tick();
			mic().click();
			// Synchronous: the prompt is requested before the click returns.
			expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
			expect(FakeRecognition.instances.length).toBe(0);
			await tick();
			expect(track.stop).toHaveBeenCalled();
			expect(last().started).toBe(true);
			expect(get(errorToast)).toBeUndefined();
		});

		it("shows the blocked message only after the prompt is denied", async () => {
			w.webkitSpeechRecognition = FakeRecognition;
			mockMic(() => Promise.reject(new DOMException("no", "NotAllowedError")));
			mount();
			await tick();
			mic().click();
			expect(get(errorToast)).toBeUndefined();
			await tick();
			expect(get(errorToast)).toContain("microphone permission is blocked");
			expect(FakeRecognition.instances.length).toBe(0);
			expect(mic().getAttribute("aria-pressed")).toBe("false");
		});

		it("a refusal from recognition after the grant is the Siri/Dictation message", async () => {
			w.webkitSpeechRecognition = FakeRecognition;
			mockMic(async () => ({ getTracks: () => [track] }));
			mount();
			await tick();
			mic().click();
			await tick();
			last().onerror?.({ error: "not-allowed" });
			last().onend?.();
			await tick();
			expect(get(errorToast)).toContain("Siri or Dictation");
		});

		it("leaves Chrome alone: no microphone request with the unprefixed constructor", async () => {
			w.SpeechRecognition = FakeRecognition;
			w.webkitSpeechRecognition = FakeRecognition;
			mockMic(async () => ({ getTracks: () => [track] }));
			mount();
			await tick();
			mic().click();
			expect(getUserMedia).not.toHaveBeenCalled();
			expect(last().started).toBe(true);
		});
	});

	it("a second click after an error starts a fresh session", async () => {
		w.SpeechRecognition = FakeRecognition;
		mount();
		await tick();
		mic().click();
		await tick();
		last().onerror?.({ error: "no-speech" });
		last().onend?.();
		await tick();
		mic().click();
		await tick();
		expect(FakeRecognition.instances.length).toBe(2);
		expect(last().started).toBe(true);
	});
});

describe("ChatInput dictation, the administrator's switch", () => {
	const cases: [string | undefined, boolean, boolean][] = [
		[undefined, false, true],
		[undefined, true, false],
		["fallback", false, true],
		["fallback", true, false],
		["yes", false, true],
		["yes", true, true],
		["no", false, false],
		["no", true, false],
	];
	for (const [dictationMode, transcriptionEnabled, shown] of cases) {
		it(`mode ${dictationMode ?? "unset"}, transcription ${transcriptionEnabled ? "on" : "off"}: ${shown ? "shown" : "hidden"}`, async () => {
			w.SpeechRecognition = FakeRecognition;
			mount({}, { dictationMode, transcriptionEnabled });
			await tick();
			expect(maybeMic() !== null).toBe(shown);
		});
	}

	it("an agent composer has no recorder, so fallback still offers dictation", async () => {
		w.SpeechRecognition = FakeRecognition;
		mount({ voiceRecorder: false }, { dictationMode: "fallback", transcriptionEnabled: true });
		await tick();
		expect(maybeMic()).not.toBeNull();
	});
});
