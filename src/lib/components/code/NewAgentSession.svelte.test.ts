import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithApp, appNavigation } from "$lib/components/__tests__/renderWithApp";
import NewAgentSession from "./NewAgentSession.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { writeLastAgentTarget } from "$lib/utils/lastAgentTarget";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const api = vi.hoisted(() => ({
	listWorkspaces: vi.fn(),
	listProviders: vi.fn(),
	listProviderModels: vi.fn(),
	listProviderModes: vi.fn(),
	createAgent: vi.fn(),
	listDevices: vi.fn(),
}));
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	...api,
}));

const dev = (id: string, over: object = {}) => ({
	id,
	name: `Box ${id}`,
	status: "paired",
	online: true,
	...over,
});
const WORKSPACES: Record<string, object[]> = {
	d1: [{ id: "w1", name: "alpha", path: "/a", isGitRepo: false }],
	d2: [
		{ id: "w2", name: "beta", path: "/b", isGitRepo: false },
		{ id: "w3", name: "gamma", path: "/c", isGitRepo: false },
	],
};

describe("NewAgentSession", () => {
	beforeEach(() => {
		localStorage.clear();
		for (const fn of Object.values(api)) fn.mockReset();
		api.listWorkspaces.mockImplementation(async (id: string) => ({ workspaces: WORKSPACES[id] }));
		api.listProviders.mockResolvedValue({ providers: [] });
		api.listDevices.mockResolvedValue({ devices: [] });
		codeDeviceList.devices = [dev("d1"), dev("d2")] as never;
		codeDeviceList.loading = false;
	});

	it("opens on the first machine and its first folder when nothing was used before", async () => {
		const screen = renderWithApp(NewAgentSession, { onclose: () => {} });
		await expect.element(screen.getByTestId("new-agent-machine")).toHaveValue("d1");
		await expect.element(screen.getByTestId("new-agent-folder")).toHaveValue("w1");
	});

	it("defaults to the machine and folder used last", async () => {
		writeLastAgentTarget({ deviceId: "d2", workspaceId: "w3" });
		const screen = renderWithApp(NewAgentSession, { onclose: () => {} });
		await expect.element(screen.getByTestId("new-agent-machine")).toHaveValue("d2");
		await expect.element(screen.getByTestId("new-agent-folder")).toHaveValue("w3");
	});

	it("ignores a last-used machine that is no longer paired", async () => {
		writeLastAgentTarget({ deviceId: "gone", workspaceId: "wx" });
		const screen = renderWithApp(NewAgentSession, { onclose: () => {} });
		await expect.element(screen.getByTestId("new-agent-machine")).toHaveValue("d1");
	});

	it("goes on to the session dialog for the chosen folder", async () => {
		api.createAgent.mockResolvedValue({ agent: { id: "a9" } });
		const onclose = vi.fn();
		const screen = renderWithApp(NewAgentSession, { onclose });
		await expect.element(screen.getByTestId("new-agent-folder")).toHaveValue("w1");
		await screen.getByTestId("new-agent-continue").click();
		// The same dialog the tree's per-folder action opens.
		await expect.element(screen.getByText("alpha").first()).toBeVisible();
		expect(api.listProviders).toHaveBeenCalledWith("d1");
		expect(appNavigation().goto).not.toHaveBeenCalled();
	});

	it("opens the pairing dialog instead when no machine is paired", async () => {
		codeDeviceList.devices = [] as never;
		const screen = renderWithApp(NewAgentSession, { onclose: () => {} });
		await expect.element(screen.getByText(/pair/i).first()).toBeVisible();
		expect(screen.getByTestId("new-agent-machine").elements()).toHaveLength(0);
	});

	it("says there are no folders and offers to add one", async () => {
		codeDeviceList.devices = [dev("d3")] as never;
		api.listWorkspaces.mockResolvedValue({ workspaces: [] });
		const screen = renderWithApp(NewAgentSession, { onclose: () => {} });
		await expect
			.element(screen.getByText("No folders on this machine yet", { exact: false }))
			.toBeVisible();
		await expect.element(screen.getByTestId("new-agent-continue")).toBeDisabled();
		await expect.element(screen.getByText("Add a folder…")).toBeEnabled();
	});
});
