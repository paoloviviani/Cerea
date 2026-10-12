import { describe, it, expect, vi, beforeEach } from "vitest";
import { writable } from "svelte/store";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentComposer from "./AgentComposer.svelte";
import { get } from "svelte/store";
import { error as errorToast } from "$lib/stores/errors";

// The composer's MCP stores read `$env/dynamic/public` at module scope and
// fetch on import; no SvelteKit env or API exists in the browser project.
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listAgentCommands: async () => ({ commands: [] }),
}));

const calls: string[] = [];
const onsend = vi.fn(async (text: string) => {
	calls.push(`send:${text}`);
});
const onstop = vi.fn<() => Promise<boolean>>(async () => {
	calls.push("stop");
	return true;
});

function settingsContext(directPaste = false) {
	const store = writable({ directPaste });
	return {
		context: new Map<unknown, unknown>([["settings", { subscribe: store.subscribe }]]),
	};
}

function mount(running: boolean, steer = true, options: { modelIsMultimodal?: boolean } = {}) {
	return renderWithApp(
		AgentComposer,
		{
			deviceId: "d1",
			agentId: "a1",
			agent: null,
			running,
			steerSupported: steer,
			onsend,
			onstop,
			onchanged: () => {},
			...(options.modelIsMultimodal !== undefined
				? { modelIsMultimodal: options.modelIsMultimodal, mimeTypes: ["image/png", "text/plain"] }
				: {}),
		},
		settingsContext()
	);
}

beforeEach(() => {
	calls.length = 0;
	onsend.mockClear();
	onstop.mockClear();
	onstop.mockImplementation(async () => {
		calls.push("stop");
		return true;
	});
	// Composer drafts persist in localStorage across mounts by design; clear
	// them so every test starts from an empty box (all mounts here share the
	// same device+agent key).
	for (let i = localStorage.length - 1; i >= 0; i--) {
		const key = localStorage.key(i);
		if (key?.startsWith("cerea:composer-draft:")) localStorage.removeItem(key);
	}
});

for (const [label, width] of [
	["desktop", 1200],
	["mobile", 400],
] as const) {
	describe(`AgentComposer steering (${label})`, () => {
		it("keeps Send beside Stop while a turn runs, and a prompt steers it", async () => {
			await browserPage.viewport(width, 800);
			const screen = mount(true);
			await expect.element(screen.getByRole("button", { name: "Stop generating" })).toBeVisible();
			const send = screen.getByRole("button", { name: "Send message" });
			await expect.element(send).toBeDisabled();

			await screen.getByPlaceholder("Follow up with the agent…").fill("also cover the edge case");
			await expect.element(send).toBeEnabled();
			await send.click();

			await vi.waitFor(() => expect(onsend).toHaveBeenCalledTimes(1));
			expect(onsend.mock.calls[0][0]).toBe("also cover the edge case");
			expect(onstop).not.toHaveBeenCalled();
		});

		it("offers no chevron, and no Stop, when idle", async () => {
			await browserPage.viewport(width, 800);
			const screen = mount(false);
			await expect.element(screen.getByRole("button", { name: "Send message" })).toBeVisible();
			expect(screen.getByRole("button", { name: "Stop generating" }).elements()).toHaveLength(0);
			expect(screen.getByRole("button", { name: "More ways to send" }).elements()).toHaveLength(0);
		});

		it("still refuses a slash command while a turn runs, on Send and on Stop and send", async () => {
			await browserPage.viewport(width, 800);
			const screen = mount(true);
			await screen.getByPlaceholder("Follow up with the agent…").fill("/new");
			await screen.getByRole("button", { name: "More ways to send" }).click();
			await screen.getByRole("menuitem", { name: "Stop and send" }).click();
			await vi.waitFor(() => expect(get(errorToast)).toMatch(/mid-turn/));
			expect(onstop).not.toHaveBeenCalled();
			expect(onsend).not.toHaveBeenCalled();

			errorToast.set(undefined);
			await screen.getByRole("button", { name: "Send message" }).click();
			await vi.waitFor(() => expect(get(errorToast)).toMatch(/mid-turn/));
			expect(onsend).not.toHaveBeenCalled();
		});

		it("shows Stop alone when the backend cannot fold a mid-turn prompt", async () => {
			await browserPage.viewport(width, 800);
			const screen = mount(true, false);
			await expect.element(screen.getByRole("button", { name: "Stop generating" })).toBeVisible();
			expect(screen.getByRole("button", { name: "Send message" }).elements()).toHaveLength(0);
			expect(screen.getByRole("button", { name: "More ways to send" }).elements()).toHaveLength(0);
		});

		it("Stop and send stops first, then sends, in that order", async () => {
			await browserPage.viewport(width, 800);
			const screen = mount(true);
			await screen.getByPlaceholder("Follow up with the agent…").fill("new direction");
			await screen.getByRole("button", { name: "More ways to send" }).click();
			await screen.getByRole("menuitem", { name: "Stop and send" }).click();

			await vi.waitFor(() => expect(calls).toEqual(["stop", "send:new direction"]));
		});

		it("Stop and send sends nothing, and keeps the draft, when the stop was refused", async () => {
			await browserPage.viewport(width, 800);
			onstop.mockImplementation(async () => {
				calls.push("stop");
				return false;
			});
			const screen = mount(true);
			await screen.getByPlaceholder("Follow up with the agent…").fill("new direction");
			await screen.getByRole("button", { name: "More ways to send" }).click();
			await screen.getByRole("menuitem", { name: "Stop and send" }).click();

			await vi.waitFor(() => expect(calls).toEqual(["stop"]));
			await expect
				.element(screen.getByPlaceholder("Follow up with the agent…"))
				.toHaveValue("new direction");
			expect(onsend).not.toHaveBeenCalled();
		});
	});
}

describe("AgentComposer image attachments", () => {
	it("offers Add image(s) when the session's model takes images", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount(true, true, { modelIsMultimodal: true });
		await screen.getByRole("button", { name: "Add attachment" }).click();
		await expect.element(screen.getByRole("menuitem", { name: "Add image(s)" })).toBeVisible();
		await expect.element(screen.getByRole("menuitem", { name: "Add text file" })).toBeVisible();
	});

	it("hides Add image(s) for a model that says nothing about images", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount(true, true, { modelIsMultimodal: false });
		await screen.getByRole("button", { name: "Add attachment" }).click();
		await expect.element(screen.getByRole("menuitem", { name: "Add text file" })).toBeVisible();
		expect(screen.getByRole("menuitem", { name: "Add image(s)" }).elements()).toHaveLength(0);
	});

	it("keeps a pasted screenshot as a chip, and drops what the allowlist refuses", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount(true, true, { modelIsMultimodal: true });

		const target = screen.getByPlaceholder("Follow up with the agent…").element() as HTMLElement;
		const dt = new DataTransfer();
		dt.items.add(new File(["png"], "shot.png", { type: "image/png" }));
		dt.items.add(new File(["pdf"], "paper.pdf", { type: "application/pdf" }));
		const event = new ClipboardEvent("paste", {
			bubbles: true,
			cancelable: true,
			clipboardData: dt,
		});
		target.dispatchEvent(event);

		// The image became a compact thumbnail (an image chip renders the name
		// as the img's alt), on its own line above the input — never in the
		// input's row, where even a small one squeezed the text. The pdf is
		// outside the allowlist and never shows.
		expect(event.defaultPrevented).toBe(true);
		await vi.waitFor(() =>
			expect(document.body.querySelector('[data-testid="composer-image-thumb"]')).not.toBeNull()
		);
		const thumb = document.body.querySelector('[data-testid="composer-image-thumb"] img');
		expect(thumb?.className).toContain("size-14");
		expect(document.body.querySelector('img[alt="paper.pdf"]')).toBeNull();
	});
});
