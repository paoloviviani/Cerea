import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentDialog from "./AgentDialog.svelte";

const api = vi.hoisted(() => ({
	listProviders: vi.fn(),
	createAgent: vi.fn(),
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	...api,
}));

const workspace = { id: "w1", path: "/home/me/project", name: "project" } as never;

function mount() {
	return renderWithApp(AgentDialog, {
		deviceId: "d1",
		workspace,
		onclose: () => {},
		oncreated: () => {},
	});
}

describe("AgentDialog backend choice", () => {
	beforeEach(() => {
		api.listProviders.mockReset();
		api.createAgent.mockReset();
	});

	it("names the machine's one backend instead of offering a one-item list", async () => {
		api.listProviders.mockResolvedValue({ providers: [{ id: "opencode", available: true }] });
		const screen = mount();
		await expect.element(screen.getByTestId("agent-backend")).toHaveTextContent("Runs on opencode");
		expect(screen.getByLabelText("Provider").elements()).toHaveLength(0);
	});

	it("offers the choice when the machine runs more than one backend", async () => {
		api.listProviders.mockResolvedValue({
			providers: [
				{ id: "opencode", available: true },
				{ id: "acp:claude", available: true },
			],
		});
		const screen = mount();
		await expect.element(screen.getByLabelText("Provider")).toBeVisible();
		expect(screen.getByTestId("agent-backend").elements()).toHaveLength(0);
	});
});
