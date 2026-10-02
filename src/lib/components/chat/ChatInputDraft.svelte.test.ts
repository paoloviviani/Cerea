import ChatInput from "./ChatInput.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { tick } from "svelte";
import { writable } from "svelte/store";

// The composer's MCP stores read `$env/dynamic/public` at module scope; the
// client project runs in a real browser where no SvelteKit env exists.
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const PREFIX = "cerea:composer-draft:";
const KEY_A = `${PREFIX}chat:draft-conv-a`;
const KEY_B = `${PREFIX}chat:draft-conv-b`;

const settingsContext = new Map<string, unknown>([["settings", writable({ activeModel: "m" })]]);

function mount(draftKey: string, onsubmit: () => void = () => {}) {
	return renderWithApp(
		ChatInput,
		{ draftKey, placeholder: "Ask anything", onsubmit },
		{
			page: {
				params: {},
				data: { user: { username: "tester" }, loginEnabled: true, shared: false },
			},
			context: settingsContext,
		}
	);
}

const boxValue = (screen: { container: HTMLElement }): string | undefined =>
	screen.container.querySelector("textarea")?.value;

async function fill(screen: ReturnType<typeof mount>, text: string) {
	await screen.getByPlaceholder("Ask anything").fill(text);
	// Let the binding and the persistence effect settle before unmounting.
	await tick();
}

function clearDraftKeys() {
	for (let i = localStorage.length - 1; i >= 0; i--) {
		const key = localStorage.key(i);
		if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
	}
}

let mounted: Array<{ unmount: () => void }> = [];

beforeEach(() => {
	mounted = [];
	clearDraftKeys();
});

afterEach(() => {
	for (const screen of mounted) screen.unmount();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	clearDraftKeys();
});

function track<T extends { unmount: () => void }>(screen: T): T {
	mounted.push(screen);
	return screen;
}

function drop(screen: { unmount: () => void }) {
	mounted = mounted.filter((entry) => entry !== screen);
	screen.unmount();
}

for (const [label, width] of [
	["desktop", 1280],
	["mobile", 390],
] as const) {
	describe(`ChatInput draft persistence (${label})`, () => {
		it("a typed draft survives a reload", async () => {
			await browserPage.viewport(width, 800);
			const first = track(mount(KEY_A));
			await fill(first, "unsent half-thought");
			// Unmounting flushes the debounced write, like a reload or a
			// navigation away mid-debounce would.
			drop(first);

			const second = track(mount(KEY_A));
			await vi.waitFor(() => expect(boxValue(second)).toBe("unsent half-thought"));
		});

		it("a landed send clears the draft, so a reload stays empty", async () => {
			await browserPage.viewport(width, 800);
			const onsubmit = vi.fn();
			const first = track(mount(KEY_A, onsubmit));
			await fill(first, "ready to send");
			drop(first);
			expect(localStorage.getItem(KEY_A)).toBe("ready to send");

			const second = track(mount(KEY_A, onsubmit));
			await vi.waitFor(() => expect(boxValue(second)).toBe("ready to send"));
			const box = second.container.querySelector("textarea");
			if (!box) throw new Error("no composer textarea");
			box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			await vi.waitFor(() => expect(onsubmit).toHaveBeenCalledTimes(1));
			// The parent clears the bound value once the send landed.
			await second.rerender({ draftKey: KEY_A, value: "" });
			await vi.waitFor(() => expect(localStorage.getItem(KEY_A)).toBeNull());
			drop(second);

			const third = track(mount(KEY_A));
			await tick();
			expect(boxValue(third)).toBe("");
		});

		it("a refused send keeps the draft", async () => {
			await browserPage.viewport(width, 800);
			// onsubmit fires but the parent never clears: the send did not
			// land, and the text must survive.
			const onsubmit = vi.fn();
			const first = track(mount(KEY_A, onsubmit));
			await fill(first, "still mine");
			const box = first.container.querySelector("textarea");
			if (!box) throw new Error("no composer textarea");
			box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			await vi.waitFor(() => expect(onsubmit).toHaveBeenCalledTimes(1));
			await vi.waitFor(() => expect(boxValue(first)).toBe("still mine"));
			drop(first);

			const second = track(mount(KEY_A));
			await vi.waitFor(() => expect(boxValue(second)).toBe("still mine"));
		});

		it("switching conversations swaps drafts, keeping each one", async () => {
			await browserPage.viewport(width, 800);
			const screen = track(mount(KEY_A));
			await fill(screen, "draft for A");
			await screen.rerender({ draftKey: KEY_B, placeholder: "Ask anything" });
			await vi.waitFor(() => expect(boxValue(screen)).toBe(""));

			await fill(screen, "draft for B");
			await screen.rerender({ draftKey: KEY_A, placeholder: "Ask anything" });
			await vi.waitFor(() => expect(boxValue(screen)).toBe("draft for A"));

			expect(localStorage.getItem(KEY_A)).toBe("draft for A");
			expect(localStorage.getItem(KEY_B)).toBe("draft for B");
		});

		it("an explicit initial value wins over a stored draft", async () => {
			await browserPage.viewport(width, 800);
			localStorage.setItem(KEY_A, "stored draft");
			const screen = track(
				renderWithApp(
					ChatInput,
					{ draftKey: KEY_A, placeholder: "Ask anything", value: "shared prompt" },
					{
						page: {
							params: {},
							data: { user: { username: "tester" }, loginEnabled: true, shared: false },
						},
						context: settingsContext,
					}
				)
			);
			await tick();
			expect(boxValue(screen)).toBe("shared prompt");
		});

		it("a full store never breaks the composer", async () => {
			await browserPage.viewport(width, 800);
			const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
				throw new DOMException("quota exceeded", "QuotaExceededError");
			});
			const screen = track(mount(KEY_A));
			// Typing, sending and remounting all keep working; only the
			// restore is lost.
			await fill(screen, "typing through the quota error");
			expect(boxValue(screen)).toBe("typing through the quota error");
			drop(screen);
			setItem.mockRestore();

			const second = track(mount(KEY_A));
			await tick();
			expect(boxValue(second)).toBe("");
			await fill(second, "works again");
			expect(boxValue(second)).toBe("works again");
		});

		it("a sign-out in another tab clears this tab's matching draft", async () => {
			await browserPage.viewport(width, 800);
			const screen = track(mount(KEY_A));
			await fill(screen, "tab A draft");
			drop(screen);
			expect(localStorage.getItem(KEY_A)).toBe("tab A draft");

			const reopened = track(mount(KEY_A));
			await vi.waitFor(() => expect(boxValue(reopened)).toBe("tab A draft"));
			// The other tab signed out: the key is removed there, and this
			// tab hears about it through the storage event.
			localStorage.removeItem(KEY_A);
			window.dispatchEvent(
				new StorageEvent("storage", { key: KEY_A, oldValue: "tab A draft", newValue: null })
			);
			await vi.waitFor(() => expect(boxValue(reopened)).toBe(""));
		});

		it("keeps this tab's newer typing when another tab signs out", async () => {
			await browserPage.viewport(width, 800);
			localStorage.setItem(KEY_A, "stale draft");
			const screen = track(mount(KEY_A));
			await vi.waitFor(() => expect(boxValue(screen)).toBe("stale draft"));
			// Typing after the other tab's sign-out must survive the event.
			await fill(screen, "fresh typing here");
			window.dispatchEvent(
				new StorageEvent("storage", { key: KEY_A, oldValue: "stale draft", newValue: null })
			);
			await tick();
			expect(boxValue(screen)).toBe("fresh typing here");
		});
	});
}
