import { describe, it, expect, vi, beforeEach } from "vitest";
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

function mount(running: boolean, steer = true) {
	return renderWithApp(AgentComposer, {
		deviceId: "d1",
		agentId: "a1",
		agent: null,
		running,
		steerSupported: steer,
		onsend,
		onstop,
		onchanged: () => {},
	});
}

beforeEach(() => {
	calls.length = 0;
	onsend.mockClear();
	onstop.mockClear();
	onstop.mockImplementation(async () => {
		calls.push("stop");
		return true;
	});
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
