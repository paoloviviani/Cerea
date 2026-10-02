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
}));

const PREFIX = "cerea:composer-draft:";
const keyFor = (deviceId: string, agentId: string) => `${PREFIX}code:${deviceId}:${agentId}`;

type Screen = ReturnType<typeof renderWithApp<typeof AgentComposer>>;
let mounted: Screen[] = [];
let onsend: ReturnType<typeof vi.fn>;

function mount(deviceId: string, agentId: string, impl?: (text: string) => Promise<void>): Screen {
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
