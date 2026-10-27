import ChatInput from "./ChatInput.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { writable } from "svelte/store";
import { COMPOSER_DRAFT_DEBOUNCE_MS } from "$lib/utils/composerDraft";

// Races around "a successful send always clears the draft, in memory and in
// storage". The parent (ChatWindow) clears the bound value right after a send,
// so each test plays that part with `rerender({ value })`.

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const PREFIX = "cerea:composer-draft:";
const HOME = `${PREFIX}chat:home`;
const CONV = `${PREFIX}chat:send-conv`;
const settingsContext = new Map<string, unknown>([["settings", writable({ activeModel: "m" })]]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAST_DEBOUNCE = COMPOSER_DRAFT_DEBOUNCE_MS + 250;

function mount(props: Record<string, unknown>) {
	return renderWithApp(
		ChatInput,
		{ placeholder: "Ask anything", ...props },
		{
			page: { params: {}, data: { user: { username: "tester" }, loginEnabled: true } },
			context: settingsContext,
		}
	);
}
type Screen = ReturnType<typeof mount>;

const boxOf = (screen: Screen) => screen.container.querySelector("textarea") as HTMLTextAreaElement;

/** Types like the browser does, without going through the (timer-driven)
 * locator, so fake timers can be on. */
async function typeFast(screen: Screen, text: string) {
	const box = boxOf(screen);
	box.focus();
	box.value = text;
	box.dispatchEvent(new Event("input", { bubbles: true }));
	await tick();
}

/** Moves the debounce clock past its delay. */
async function pastDebounce() {
	await vi.advanceTimersByTimeAsync(COMPOSER_DRAFT_DEBOUNCE_MS + 1);
}

function clearDraftKeys() {
	for (let i = localStorage.length - 1; i >= 0; i--) {
		const key = localStorage.key(i);
		if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
	}
}

let mounted: Screen[] = [];
const track = (s: Screen) => (mounted.push(s), s);
beforeEach(() => {
	mounted = [];
	clearDraftKeys();
});
afterEach(() => {
	for (const s of mounted) s.unmount();
	clearDraftKeys();
	vi.restoreAllMocks();
});

describe("a landed send leaves no draft behind", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a debounced save still pending at the send never lands afterwards", async () => {
		const s = track(mount({ draftKey: CONV }));
		await typeFast(s, "typed a moment ago");
		// The write is still debounced; the send clears the box now.
		await s.rerender({ draftKey: CONV, value: "" });
		await pastDebounce();
		expect(localStorage.getItem(CONV)).toBeNull();
		s.unmount();
		mounted = [];
		expect(localStorage.getItem(CONV)).toBeNull();
	});

	it("text typed while the send is in flight is kept and saved; the sent text is not", async () => {
		const s = track(mount({ draftKey: CONV }));
		await typeFast(s, "the sent one");
		await s.rerender({ draftKey: CONV, value: "" });
		await typeFast(s, "the next one");
		await pastDebounce();
		expect(localStorage.getItem(CONV)).toBe("the next one");
		expect(boxOf(s).value).toBe("the next one");
	});

	it("first message of a new chat: the key flips from home after the clear", async () => {
		const s = track(mount({ draftKey: HOME }));
		await typeFast(s, "first message");
		await s.rerender({ draftKey: HOME, value: "" });
		await s.rerender({ draftKey: CONV, value: "" });
		await pastDebounce();
		expect(localStorage.getItem(HOME)).toBeNull();
		expect(localStorage.getItem(CONV)).toBeNull();
		expect(boxOf(s).value).toBe("");
	});

	it("first message of a new chat: the remount under the new key restores nothing", async () => {
		const home = mount({ draftKey: HOME });
		await typeFast(home, "first message");
		await home.rerender({ draftKey: HOME, value: "" });
		home.unmount();
		const conv = track(mount({ draftKey: CONV }));
		await pastDebounce();
		expect(boxOf(conv).value).toBe("");
		expect(localStorage.getItem(HOME)).toBeNull();
		const back = track(mount({ draftKey: HOME }));
		await tick();
		expect(boxOf(back).value).toBe("");
	});
});

describe("another tab", () => {
	it("a send in one tab empties the same conversation's composer in another", async () => {
		localStorage.setItem(CONV, "shared draft");
		const tabB = track(mount({ draftKey: CONV }));
		await vi.waitFor(() => expect(boxOf(tabB).value).toBe("shared draft"));
		// Tab A sent: its composer cleared and removed the key.
		localStorage.removeItem(CONV);
		window.dispatchEvent(
			new StorageEvent("storage", { key: CONV, oldValue: "shared draft", newValue: null })
		);
		await vi.waitFor(() => expect(boxOf(tabB).value).toBe(""));
		await wait(PAST_DEBOUNCE);
		expect(localStorage.getItem(CONV)).toBeNull();
	});
});

describe("dictation cannot write after a send", () => {
	type Result = { isFinal: boolean; 0: { transcript: string } };
	class FakeRecognition {
		static last: FakeRecognition;
		lang = "";
		continuous = false;
		interimResults = false;
		onresult: ((e: { results: Result[] }) => void) | null = null;
		onerror: ((e: { error: string }) => void) | null = null;
		onend: (() => void) | null = null;
		constructor() {
			FakeRecognition.last = this;
		}
		start() {}
		stop() {}
		abort() {}
		say(t: string) {
			this.onresult?.({ results: [{ isFinal: true, 0: { transcript: t } }] });
		}
	}
	const w = window as unknown as Record<string, unknown>;
	afterEach(() => {
		w.SpeechRecognition = undefined;
		w.webkitSpeechRecognition = undefined;
	});

	it("a late result after the send is dropped", async () => {
		w.webkitSpeechRecognition = undefined;
		w.SpeechRecognition = FakeRecognition;
		const s = track(mount({ draftKey: CONV }));
		await vi.waitFor(() => expect(document.querySelector("button[aria-pressed]")).not.toBeNull());
		document.querySelector<HTMLButtonElement>("button[aria-pressed]")?.click();
		await tick();
		const rec = FakeRecognition.last;
		rec.say("dictated words");
		await vi.waitFor(() => expect(boxOf(s).value).toBe("dictated words"));
		const stale = rec.onresult;
		// The send: the parent clears the draft.
		await s.rerender({ draftKey: CONV, value: "" });
		await tick();
		// A result that was already on its way, and the handler the engine
		// would still hold, both land after the clear.
		rec.say("dictated words too late");
		stale?.({ results: [{ isFinal: true, 0: { transcript: "even later" } }] });
		await wait(PAST_DEBOUNCE);
		expect(boxOf(s).value).toBe("");
		expect(localStorage.getItem(CONV)).toBeNull();
	});
});
