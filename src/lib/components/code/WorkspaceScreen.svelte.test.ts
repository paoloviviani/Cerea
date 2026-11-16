import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp, unmountRendered } from "$lib/components/__tests__/renderWithApp";
import WorkspaceScreen from "./WorkspaceScreen.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";

/**
 * The workspace screen: what a workspace click opens, with no session. New
 * session, the workspace's sessions, and Terminal and Files at the top right,
 * hidden when the deployment, the machine or its policy does not offer them.
 */
const api = vi.hoisted(() => ({
	listWorkspaces: vi.fn(),
	listWorkspaceAgents: vi.fn(),
}));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listWorkspaces: api.listWorkspaces,
	listWorkspaceAgents: api.listWorkspaceAgents,
	listWorkspaceFiles: async () => ({ entries: [] }),
	listProviders: async () => ({ providers: [] }),
}));

// The two panels are tested on their own; here only that they mount, rooted at the workspace.
vi.mock("./CodeFiles.svelte", async () => ({
	default: (await import("./__tests__/PanelStub.svelte")).default,
}));
vi.mock("./CodeTerminals.svelte", async () => ({
	default: (await import("./__tests__/PanelStub.svelte")).default,
}));

const WS = { id: "w1", name: "/home/me/cloud_sync", path: "/home/me/cloud_sync", isGitRepo: true };
const AGENT = {
	id: "a1",
	workspaceId: "w1",
	title: "Fix the sync bug",
	provider: "opencode",
	state: "done",
	updatedAt: new Date().toISOString(),
	modeId: null,
	modelId: null,
};

function device(over: Record<string, unknown> = {}) {
	return {
		id: "d1",
		name: "Box",
		status: "paired",
		online: true,
		machine: { capabilities: { files: true, fileWrite: true, terminal: true } },
		policy: { files: "read", fileWrite: "allowed", terminal: "allowed" },
		...over,
	};
}

function mount(opts: { data?: Record<string, unknown>; device?: Record<string, unknown> } = {}) {
	codeDeviceList.devices = [device(opts.device)] as never;
	return renderWithApp(
		WorkspaceScreen,
		{ deviceId: "d1", workspaceId: "w1" },
		{
			page: {
				url: "/code?device=d1&ws=w1",
				data: {
					codeFilesEnabled: true,
					codeFileWriteEnabled: true,
					codeTerminalEnabled: true,
					...opts.data,
				},
			},
		}
	);
}

beforeEach(async () => {
	api.listWorkspaces.mockReset().mockResolvedValue({ workspaces: [WS] });
	api.listWorkspaceAgents.mockReset().mockResolvedValue({ agents: [AGENT] });
	sidePane.reset();
	await browserPage.viewport(1200, 800);
});

afterEach(() => {
	unmountRendered();
	sidePane.reset();
});

describe("WorkspaceScreen", () => {
	it("names the workspace, lists its sessions as links, and has a New session button", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("agent-header")).toHaveTextContent("cloud_sync");
		await expect
			.element(screen.getByTestId("workspace-path"))
			.toHaveTextContent("/home/me/cloud_sync");
		const link = screen.getByTestId("workspace-session");
		await expect.element(link).toHaveTextContent("Fix the sync bug");
		await expect
			.element(link)
			.toHaveAttribute("href", expect.stringContaining("/code?device=d1&ws=w1&agent=a1"));
		await expect.element(screen.getByTestId("workspace-new-session")).toBeEnabled();
		expect(api.listWorkspaceAgents).toHaveBeenCalledWith("d1", "w1");
	});

	it("says so when the workspace has no session yet", async () => {
		api.listWorkspaceAgents.mockResolvedValue({ agents: [] });
		const screen = mount();
		await expect.element(screen.getByTestId("workspace-no-sessions")).toBeVisible();
	});

	it("offers Terminal and Files at the top right, and each opens its panel on this workspace", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("workspace-path")).toBeVisible();
		await screen.getByRole("button", { name: "Files" }).click();
		const panel = screen.getByTestId("panel-stub");
		await expect.element(panel).toHaveTextContent("d1 w1");
		await screen.getByRole("button", { name: "Terminal" }).click();
		await expect.element(screen.getByTestId("panel-stub")).toHaveTextContent("d1 w1");
		expect(sidePane.view).toBe("terminal");
	});

	it("hides Terminal when the machine's policy has none, and Files when the explorer is off", async () => {
		const screen = mount({
			device: { policy: { files: "off", fileWrite: "denied", terminal: "denied" } },
		});
		await expect.element(screen.getByTestId("workspace-path")).toBeVisible();
		expect(screen.getByRole("button", { name: "Files" }).elements()).toHaveLength(0);
		expect(screen.getByRole("button", { name: "Terminal" }).elements()).toHaveLength(0);
	});

	it("hides Terminal when the deployment or this galopin has none, but keeps Files", async () => {
		const screen = mount({
			data: { codeTerminalEnabled: false },
		});
		await expect.element(screen.getByRole("button", { name: "Files" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Terminal" }).elements()).toHaveLength(0);
	});

	it("does not ask an offline machine, and says so", async () => {
		const screen = mount({ device: { online: false } });
		await expect.element(screen.getByTestId("workspace-offline")).toBeVisible();
		expect(api.listWorkspaces).not.toHaveBeenCalled();
	});

	it("keeps the panels behind one Panels button on a phone, like a session", async () => {
		await browserPage.viewport(390, 800);
		const screen = mount();
		await expect.element(screen.getByTestId("workspace-path")).toBeVisible();
		expect(screen.getByRole("button", { name: "Files" }).elements()).toHaveLength(0);
	});
});
