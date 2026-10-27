import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { tick } from "svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentComposer from "./AgentComposer.svelte";

// The composer's MCP stores read `$env/dynamic/public` at module scope and
// fetch on import; no SvelteKit env or API exists in the browser project.
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listAgentCommands: async () => ({ commands: [] }),
	// `/compact` waits on this, so a test can switch agent mid-run.
	compactAgent: async () => compactGate(),
}));

let compactGate: () => Promise<void> = async () => {};

const PREFIX = "cerea:composer-draft:";
const keyFor = (deviceId: string, agentId: string) => `${PREFIX}code:${deviceId}:${agentId}`;

type Screen = ReturnType<typeof renderWithApp<typeof AgentComposer>>;
let mounted: Screen[] = [];
let onsend: ReturnType<typeof vi.fn>;

function mount(
	deviceId: string,
	agentId: string,
	impl?: (text: string) => Promise<void>,
	extra: Record<string, unknown> = {}
): Screen {
	onsend = vi.fn(impl ?? (async () => {}));
	const screen = renderWithApp(AgentComposer, {
		deviceId,
		agentId,
		agent: null,
		running: false,
		steerSupported: true,
		onsend,
		onstop: async () => true,
		onchanged: () => {},
		...extra,
	});
	mounted.push(screen);
	return screen;
}

function drop(screen: Screen) {
	mounted = mounted.filter((entry) => entry !== screen);
	screen.unmount();
}

const box = (screen: Screen) => screen.getByPlaceholder("Follow up with the agent…");

async function fill(screen: Screen, text: string) {
	await box(screen).fill(text);
	// Let the binding and the persistence effect settle before unmounting.
	await tick();
}

const boxValue = (screen: Screen): string | undefined =>
	screen.container.querySelector("textarea")?.value;

function clearDraftKeys() {
	for (let i = localStorage.length - 1; i >= 0; i--) {
		const key = localStorage.key(i);
		if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
	}
}

beforeEach(() => {
	mounted = [];
	clearDraftKeys();
});

afterEach(() => {
	for (const screen of mounted) screen.unmount();
	vi.restoreAllMocks();
	clearDraftKeys();
});

for (const [label, width] of [
	["desktop", 1200],
	["mobile", 400],
] as const) {
	describe(`AgentComposer draft persistence (${label})`, () => {
		it("a typed follow-up survives a reload", async () => {
			await browserPage.viewport(width, 800);
			const first = mount("d1", "a1");
			await fill(first, "unsent follow-up");
			drop(first);

			const second = mount("d1", "a1");
			await vi.waitFor(() => expect(boxValue(second)).toBe("unsent follow-up"));
		});

		it("a landed send clears the draft, so returning stays empty", async () => {
			await browserPage.viewport(width, 800);
			const first = mount("d1", "a1");
			await fill(first, "ready to send");
			drop(first);
			expect(localStorage.getItem(keyFor("d1", "a1"))).toBe("ready to send");

			const second = mount("d1", "a1");
			await vi.waitFor(() => expect(boxValue(second)).toBe("ready to send"));
			await second.getByRole("button", { name: "Send message" }).click();
			await vi.waitFor(() => expect(onsend).toHaveBeenCalledTimes(1));
			await vi.waitFor(() => expect(boxValue(second)).toBe(""));
			await vi.waitFor(() => expect(localStorage.getItem(keyFor("d1", "a1"))).toBeNull());
			drop(second);

			const third = mount("d1", "a1");
			await tick();
			expect(boxValue(third)).toBe("");
		});

		it("a failed send keeps the draft", async () => {
			await browserPage.viewport(width, 800);
			const first = mount("d1", "a1", async () => {
				throw new Error("the daemon refused the prompt");
			});
			await fill(first, "kept after refusal");
			await first.getByRole("button", { name: "Send message" }).click();
			await vi.waitFor(() => expect(onsend).toHaveBeenCalledTimes(1));
			// The composer never cleared: neither the box nor the stored draft moved.
			await vi.waitFor(() => expect(boxValue(first)).toBe("kept after refusal"));
			drop(first);

			const second = mount("d1", "a1");
			await vi.waitFor(() => expect(boxValue(second)).toBe("kept after refusal"));
		});

		it("leaving mid-send does not bring the sent text back when it lands", async () => {
			await browserPage.viewport(width, 800);
			let land: () => void = () => {};
			const first = mount(
				"d1",
				"a1",
				() =>
					new Promise<void>((resolve) => {
						land = resolve;
					})
			);
			await fill(first, "sent while leaving");
			await first.getByRole("button", { name: "Send message" }).click();
			await vi.waitFor(() => expect(onsend).toHaveBeenCalledTimes(1));
			// The person navigates away before the daemon answers; unmounting
			// lands the draft, which is still the text being sent.
			drop(first);
			expect(localStorage.getItem(keyFor("d1", "a1"))).toBe("sent while leaving");
			land();
			await vi.waitFor(() => expect(localStorage.getItem(keyFor("d1", "a1"))).toBeNull());

			const back = mount("d1", "a1");
			await tick();
			expect(boxValue(back)).toBe("");
		});

		it("switching agents mid-send does not leave the sent text under the old agent", async () => {
			await browserPage.viewport(width, 800);
			let land: () => void = () => {};
			const first = mount(
				"d1",
				"a1",
				() =>
					new Promise<void>((resolve) => {
						land = resolve;
					})
			);
			// The other agent holds the very same words: only the key guard, not
			// the text comparison, tells the two drafts apart.
			localStorage.setItem(keyFor("d1", "a2"), "sent from a1");
			await fill(first, "sent from a1");
			await first.getByRole("button", { name: "Send message" }).click();
			await vi.waitFor(() => expect(onsend).toHaveBeenCalledTimes(1));
			await first.rerender({ deviceId: "d1", agentId: "a2" });
			await vi.waitFor(() => expect(boxValue(first)).toBe("sent from a1"));
			land();
			await vi.waitFor(() => expect(localStorage.getItem(keyFor("d1", "a1"))).toBeNull());
			// The other agent's composer and draft were not touched by the landing send.
			await tick();
			expect(boxValue(first)).toBe("sent from a1");
			expect(localStorage.getItem(keyFor("d1", "a2"))).toBe("sent from a1");
		});

		it("text typed under the same agent while the send is in flight is kept", async () => {
			await browserPage.viewport(width, 800);
			let land: () => void = () => {};
			const first = mount(
				"d1",
				"a1",
				() =>
					new Promise<void>((resolve) => {
						land = resolve;
					})
			);
			await fill(first, "the sent one");
			await first.getByRole("button", { name: "Send message" }).click();
			await vi.waitFor(() => expect(onsend).toHaveBeenCalledTimes(1));
			await fill(first, "the next one");
			land();
			await tick();
			await vi.waitFor(() => expect(boxValue(first)).toBe("the next one"));
			drop(first);
			expect(localStorage.getItem(keyFor("d1", "a1"))).toBe("the next one");
		});

		for (const via of ["the send button", "Enter"] as const) {
			it(`a slow command from ${via}, with the agent switched mid-run, spares the new agent's draft`, async () => {
				await browserPage.viewport(width, 800);
				let finish: () => void = () => {};
				compactGate = () =>
					new Promise<void>((resolve) => {
						finish = resolve;
					});
				const first = mount("d1", "a1", undefined, { compactSupported: true });
				localStorage.setItem(keyFor("d1", "a2"), "a2's own draft");
				await fill(first, "/compact");
				if (via === "Enter") {
					const ta = first.container.querySelector("textarea");
					ta?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
				} else {
					await first.getByRole("button", { name: "Send message" }).click();
				}
				await tick();
				await first.rerender({ deviceId: "d1", agentId: "a2" });
				await vi.waitFor(() => expect(boxValue(first)).toBe("a2's own draft"));
				finish();
				await vi.waitFor(() => expect(localStorage.getItem(keyFor("d1", "a1"))).toBeNull());
				await tick();
				expect(boxValue(first)).toBe("a2's own draft");
				expect(localStorage.getItem(keyFor("d1", "a2"))).toBe("a2's own draft");
				compactGate = async () => {};
			});
		}

		it("each device+agent keeps its own draft", async () => {
			await browserPage.viewport(width, 800);
			const first = mount("d1", "a1");
			await fill(first, "draft for a1");
			drop(first);

			// A sibling agent starts empty, not with a1's text.
			const sibling = mount("d1", "a2");
			await tick();
			expect(boxValue(sibling)).toBe("");
			await fill(sibling, "draft for a2");
			drop(sibling);

			expect(localStorage.getItem(keyFor("d1", "a1"))).toBe("draft for a1");
			expect(localStorage.getItem(keyFor("d1", "a2"))).toBe("draft for a2");

			const back = mount("d1", "a1");
			await vi.waitFor(() => expect(boxValue(back)).toBe("draft for a1"));
		});
	});
}
