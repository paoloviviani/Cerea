import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import HandoffDialog from "./HandoffDialog.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import type { CodeAgentSession } from "$lib/types/CodeAgent";

/**
 * The fork dialog collects the target and prefills it from the source, then
 * hands off. What is under test here is the one decision the dialog owns:
 * the fork ALWAYS carries the conversation — the old toggle let a person
 * produce what was really a brand-new session with no memory of the work,
 * which is not a fork.
 */
const api = vi.hoisted(() => ({
	handoffAgent: vi.fn(),
	listWorkspaces: vi.fn(),
	listProviderModes: vi.fn(),
	listProviderModels: vi.fn(),
}));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => {
	const original = await importOriginal<typeof import("$lib/codeApi")>();
	return {
		...original,
		handoffAgent: api.handoffAgent,
		listWorkspaces: api.listWorkspaces,
		listProviderModes: api.listProviderModes,
		listProviderModels: api.listProviderModels,
	};
});

const HANDOFF_RESULT: { agent: CodeAgentSession; deviceId: string } = {
	deviceId: "d1",
	agent: { id: "a2", workspaceId: "w1", title: "Fork: Fix the bug" } as CodeAgentSession,
};

function mount() {
	return renderWithApp(
		HandoffDialog,
		{
			deviceId: "d1",
			agentId: "a1",
			agentTitle: "Fix the bug",
			workspace: { id: "w1", name: "Cerea", path: "/home/me/cerea", isGitRepo: true },
			provider: "opencode",
			modeId: "build",
			modelId: "claude-sonnet",
			uptoMessageId: "msg-9",
			onclose: () => {},
			onhandoff: () => {},
		},
		undefined
	);
}

beforeEach(() => {
	codeDeviceList.devices = [
		{ id: "d1", name: "Box d1", status: "paired", online: true },
	] as typeof codeDeviceList.devices;
	codeDeviceList.loading = false;
	api.handoffAgent.mockReset().mockResolvedValue(HANDOFF_RESULT);
	api.listWorkspaces.mockReset().mockResolvedValue({
		workspaces: [{ id: "w1", name: "Cerea", path: "/home/me/cerea", isGitRepo: true }],
	});
	api.listProviderModes.mockReset().mockResolvedValue({
		modes: [{ id: "build", label: "Build" }],
	});
	api.listProviderModels.mockReset().mockResolvedValue({
		models: [{ id: "claude-sonnet", label: "Claude Sonnet" }],
	});
});

describe("HandoffDialog", () => {
	it("offers no carry toggle: the conversation is always carried", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();

		// The old checkbox and its "starts cold" wording are gone.
		expect(document.body.querySelector('input[type="checkbox"]')).toBeNull();
		expect(document.body.textContent).not.toContain("Carry the conversation up to here");
		expect(document.body.textContent).not.toContain("starts cold");
		// What the fork does is still said, plainly.
		await expect.element(screen.getByText("carries a summary of this conversation")).toBeVisible();
	});

	it("the handoff sends carry: true with the prompt and the fork point", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();

		await screen.getByPlaceholder("What should the new agent do?").fill("Carry on from there");
		await screen.getByRole("button", { name: "Fork" }).click();

		await vi.waitFor(() => expect(api.handoffAgent).toHaveBeenCalledTimes(1));
		expect(api.handoffAgent.mock.calls[0]).toEqual([
			"d1",
			"a1",
			{
				prompt: "Carry on from there",
				carry: true,
				workspaceId: "w1",
				modeId: "build",
				modelId: "claude-sonnet",
				uptoMessageId: "msg-9",
			},
		]);
	});
});
