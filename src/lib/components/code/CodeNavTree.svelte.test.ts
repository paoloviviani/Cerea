import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushSync } from "svelte";
import { appNavigation, renderWithApp } from "$lib/components/__tests__/renderWithApp";
import CodeNavTree from "./CodeNavTree.svelte";
import { livePage } from "./codeNavPage.svelte";
import { CODE_TREE_COLLAPSE_KEY } from "$lib/utils/codeTreeCollapse";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { clearCodePanelCache } from "$lib/stores/codeTreeCache.svelte";
import { codeLegacyMachines } from "$lib/stores/codeLegacyMachines.svelte";

/**
 * The daemon side is a fake; what is under test is the tree's own decisions:
 * which rows honour their collapse state, when navigation reveals a folded
 * row, and where the nesting guides are drawn.
 */
const apiMock = vi.hoisted(() => ({
	listDevices: vi.fn(),
	listWorkspaces: vi.fn(),
	listAgents: vi.fn(),
	getPermissionRules: vi.fn(),
	getDelegateProfiles: vi.fn(),
	listProviderModels: vi.fn(),
}));

vi.mock("$app/state", async () => {
	const { livePage } = await import("./codeNavPage.svelte");
	return {
		page: livePage,
		navigating: { from: null, to: null, type: null, willUnload: false, delta: undefined },
		updated: { current: false, check: async () => false },
	};
});

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listDevices: apiMock.listDevices,
	listWorkspaces: apiMock.listWorkspaces,
	listAgents: apiMock.listAgents,
	getPermissionRules: apiMock.getPermissionRules,
	getDelegateProfiles: apiMock.getDelegateProfiles,
	listProviderModels: apiMock.listProviderModels,
}));

function device(id: string, over: Record<string, unknown> = {}) {
	return { id, name: `Box ${id}`, status: "paired", online: true, ...over };
}
function agent(id: string, workspaceId: string) {
	return {
		id,
		workspaceId,
		title: `Agent ${id}`,
		provider: "opencode",
		state: "idle",
		updatedAt: "2026-09-30T00:00:00Z",
		modeId: null,
		modelId: null,
	};
}

const WORKSPACES: Record<string, unknown[]> = {
	d1: [{ id: "w1", name: "alpha", path: "/a", isGitRepo: false }],
	d2: [{ id: "w2", name: "beta", path: "/b", isGitRepo: false }],
};
const AGENTS: Record<string, unknown[]> = {
	d1: [agent("a1", "w1"), agent("a2", "w1")],
	d2: [agent("a3", "w2")],
};

function go(search: string) {
	livePage.url = new URL(`http://localhost:3000/code${search}`);
	flushSync();
}

function mount(devices = [device("d1"), device("d2")]) {
	apiMock.listDevices.mockResolvedValue({ devices });
	return renderWithApp(CodeNavTree);
}

function rails(screen: ReturnType<typeof mount>, kind: "device" | "workspace") {
	return screen.baseElement.querySelectorAll(`[data-testid="${kind}-rail"]`);
}

beforeEach(() => {
	localStorage.clear();
	clearCodePanelCache();
	codeDeviceList.devices = [];
	codeDeviceList.loading = true;
	livePage.url = new URL("http://localhost:3000/code");
	apiMock.listDevices.mockReset();
	apiMock.listWorkspaces.mockReset().mockImplementation(async (id: string) => ({
		workspaces: WORKSPACES[id] ?? [],
	}));
	apiMock.listAgents.mockReset().mockImplementation(async (id: string) => ({
		agents: AGENTS[id] ?? [],
	}));
	apiMock.getPermissionRules.mockReset().mockRejectedValue({ status: 404 });
});

describe("CodeNavTree collapse", () => {
	it("folds the selected device and workspace, and navigation reveals them again", async () => {
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount();
		await expect.element(screen.getByText("Agent a1")).toBeVisible();

		await screen.getByRole("button", { name: "Collapse Box d1" }).click();
		await expect.element(screen.getByText("Agent a1")).not.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Expand Box d1" }))
			.toHaveAttribute("aria-expanded", "false");

		// Somewhere else in the tree: the folded row is revealed, once.
		go("?device=d1&ws=w1&agent=a2");
		await expect.element(screen.getByText("Agent a2")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Collapse Box d1" }))
			.toHaveAttribute("aria-expanded", "true");

		// ...and after that it is theirs to fold again.
		await screen.getByRole("button", { name: "Collapse alpha" }).click();
		await expect.element(screen.getByText("Agent a2")).not.toBeInTheDocument();
		await expect.element(screen.getByText("Agent a1")).not.toBeInTheDocument();
	});

	it("keeps a fold across a remount, the selection notwithstanding", async () => {
		go("?device=d1&ws=w1&agent=a1");
		const first = mount();
		await expect.element(first.getByText("Agent a1")).toBeVisible();
		await first.getByRole("button", { name: "Collapse Box d1" }).click();
		expect(JSON.parse(localStorage.getItem(CODE_TREE_COLLAPSE_KEY) ?? "{}").devices).toEqual([
			"d1",
		]);
		first.unmount();

		const second = mount();
		await expect
			.element(second.getByRole("button", { name: "Expand Box d1" }))
			.toHaveAttribute("aria-expanded", "false");
		await expect.element(second.getByText("Agent a1")).not.toBeInTheDocument();
	});

	it("tints a folded row that holds the selection", async () => {
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount();
		await expect.element(screen.getByText("Agent a1")).toBeVisible();
		const link = () => screen.getByRole("link", { name: "Box d1" }).element();
		// Expanded with an agent open: the agent carries the tint, not the device.
		expect(link().className).not.toContain("bg-gray-100 font-semibold");

		await screen.getByRole("button", { name: "Collapse alpha" }).click();
		const wsRow = screen.getByText("alpha").element().closest("span.flex");
		// Holds the selection, is not the selection: a lighter wash, not the
		// selected row's tint.
		expect(wsRow?.className).not.toContain("font-semibold");
		expect(wsRow?.className).toContain("bg-gray-50");
		expect(wsRow?.hasAttribute("data-holds-selection")).toBe(true);

		await screen.getByRole("button", { name: "Collapse Box d1" }).click();
		// A machine row is always bold — the fold shows in the lighter wash
		// and the marker, not a lighter weight.
		expect(link().className).toContain("font-semibold");
		expect(link().className).toContain("bg-gray-50");
		expect(link().hasAttribute("data-holds-selection")).toBe(true);
	});

	it("gives the full tint to a row that is itself the selection", async () => {
		go("?device=d1&ws=w1");
		const screen = mount();
		await expect.element(screen.getByText("alpha")).toBeVisible();
		const wsRow = screen.getByText("alpha").element().closest("span.flex");
		expect(wsRow?.className).toContain("bg-gray-100 font-semibold");
		expect(wsRow?.hasAttribute("data-holds-selection")).toBe(false);
	});
});

describe("CodeNavTree rails", () => {
	it("guides only the sessions under each workspace: machines carry no gutter", async () => {
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([
			device("d1"),
			device("d2"),
			device("d3", { status: "pending" }),
			device("d4", { reenroll: "revoked" }),
		]);
		await expect.element(screen.getByText("Agent a1")).toBeVisible();
		await expect.element(screen.getByText("Agent a3")).toBeVisible();

		// d1 and d2 each: a device group and one workspace rail. The pending
		// and revoked rows have no subtree to guide. The device group shows
		// no border: workspaces start at the left edge and the vertical
		// space between machines keeps the groups apart.
		expect(rails(screen, "device")).toHaveLength(2);
		expect(rails(screen, "workspace")).toHaveLength(2);
		expect(rails(screen, "device")[0]?.className).not.toContain("border-l");
		expect(rails(screen, "workspace")[0]?.className).toContain("border-l");

		await screen.getByRole("button", { name: "Collapse alpha" }).click();
		expect(rails(screen, "workspace")).toHaveLength(1);

		await screen.getByRole("button", { name: "Collapse Box d2" }).click();
		expect(rails(screen, "device")).toHaveLength(1);
		expect(rails(screen, "workspace")).toHaveLength(0);
	});
});

describe("CodeNavTree nesting", () => {
	const reset = () => (AGENTS.d1 = [agent("a1", "w1"), agent("a2", "w1")]);
	const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim();
	const spawnedBy = (id: string, by: string) => ({
		...agent(id, "w1"),
		spawnedBy: { sessionId: by, title: `Agent ${by}` },
	});

	it("puts a subagent and a spawned session under their parent, in one connector group", async () => {
		AGENTS.d1 = [
			agent("a1", "w1"),
			{ ...agent("a2", "w1"), parentId: "a1" },
			spawnedBy("a3", "a1"),
			agent("a5", "w1"),
		];
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a3")).toBeVisible();

		const groups = screen.baseElement.querySelectorAll('[data-testid="session-children"]');
		expect(groups).toHaveLength(1);
		expect(groups[0]?.className).toContain("border-l");
		const group = groups[0] as HTMLElement;
		const kinds = [...group.querySelectorAll('[data-testid="session-row"]')].map((row) => [
			row.getAttribute("data-kind"),
			row.querySelector("a")?.getAttribute("title"),
		]);
		expect(kinds).toEqual([
			["subtask", "Agent a2"],
			["delegate", "Agent a3"],
		]);
		// The group hangs off a1's own block, inside the workspace's rail; a5 is
		// an ordinary top-level row beside it.
		expect(groups[0]?.closest('[data-testid="workspace-rail"]')).not.toBeNull();
		expect(groups[0]?.parentElement?.querySelector('a[title="Agent a1"]')).not.toBeNull();
		expect(groups[0]?.querySelector('a[title="Agent a5"]')).toBeNull();
		// Nesting replaces the badge and both provenance lines.
		for (const id of ["spawned-from", "subagent-from", "spawned-count", "subagent-badge"]) {
			expect(screen.baseElement.querySelectorAll(`[data-testid="${id}"]`)).toHaveLength(0);
		}
		// Subtask rows use the smaller type; delegates match a top-level row.
		expect(groups[0]?.querySelector('[data-kind="subtask"] a')?.className).toContain(
			"text-[0.8rem]"
		);
		reset();
	});

	it("shows two nested rows and '+N more', which opens the rest and closes again", async () => {
		AGENTS.d1 = [
			agent("a1", "w1"),
			spawnedBy("a2", "a1"),
			spawnedBy("a3", "a1"),
			spawnedBy("a4", "a1"),
			spawnedBy("a5", "a1"),
		];
		go("");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a3")).toBeVisible();
		const titles = () =>
			[...screen.baseElement.querySelectorAll('[data-testid="session-children"] a[title]')].map(
				(a) => a.getAttribute("title")
			);
		expect(titles()).toEqual(["Agent a2", "Agent a3"]);
		await expect.element(screen.getByTestId("children-more")).toHaveTextContent("+2 more");

		await screen.getByTestId("children-more").click();
		expect(titles()).toEqual(["Agent a2", "Agent a3", "Agent a4", "Agent a5"]);
		await expect.element(screen.getByTestId("children-more")).toHaveTextContent("Show fewer");

		await screen.getByTestId("children-more").click();
		expect(titles()).toEqual(["Agent a2", "Agent a3"]);
		reset();
	});

	it("shows exactly two without a '+N more', and keeps a hidden child that is the open session", async () => {
		AGENTS.d1 = [agent("a1", "w1"), spawnedBy("a2", "a1"), spawnedBy("a3", "a1")];
		go("");
		const first = mount([device("d1")]);
		await expect.element(first.getByText("Agent a3")).toBeVisible();
		expect(first.getByTestId("children-more").elements()).toHaveLength(0);
		first.unmount();

		AGENTS.d1 = [
			agent("a1", "w1"),
			spawnedBy("a2", "a1"),
			spawnedBy("a3", "a1"),
			spawnedBy("a4", "a1"),
			spawnedBy("a5", "a1"),
		];
		go("?device=d1&ws=w1&agent=a5");
		const second = mount([device("d1")]);
		await expect.element(second.getByText("Agent a5")).toBeVisible();
		// a4 stays folded; a5, the open session, is shown though it is the fourth.
		expect(second.baseElement.querySelector('a[title="Agent a4"]')).toBeNull();
		await expect.element(second.getByTestId("children-more")).toHaveTextContent("+1 more");
		reset();
	});

	it("keeps a subagent whose parent is in another workspace top-level, with its 'from' line", async () => {
		WORKSPACES.d1 = [
			{ id: "w1", name: "alpha", path: "/a", isGitRepo: false },
			{ id: "w3", name: "gamma", path: "/g", isGitRepo: false },
		];
		AGENTS.d1 = [agent("a1", "w1"), { ...agent("a2", "w3"), parentId: "a1" }];
		go("");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a2")).toBeVisible();
		expect(screen.baseElement.querySelectorAll('[data-testid="session-children"]')).toHaveLength(0);
		const from = screen.baseElement.querySelectorAll('[data-testid="subagent-from"]');
		expect(from).toHaveLength(1);
		expect(text(from[0])).toBe("↳ from Agent a1 · alpha");
		WORKSPACES.d1 = [{ id: "w1", name: "alpha", path: "/a", isGitRepo: false }];
		reset();
	});

	it("says who spawned a session whose spawner is gone, and labels it as such", async () => {
		AGENTS.d1 = [
			{ ...agent("a4", "w1"), spawnedBy: { sessionId: "gone", title: "Old planner" } },
			agent("a2", "w1"),
		];
		go("?device=d1&ws=w1&agent=a2");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a4")).toBeVisible();
		const froms = [...screen.baseElement.querySelectorAll('[data-testid="spawned-from"]')];
		expect(froms.map(text)).toEqual(["spawned by Old planner (gone)"]);
		expect(froms[0]?.tagName).toBe("P");
		expect(froms[0]?.className).toContain("text-gray-400");
		expect(screen.baseElement.querySelectorAll('[data-testid="session-children"]')).toHaveLength(0);
		reset();
	});

	it("labels a subagent whose turn a Stop cut short as cancelled, not finished", async () => {
		AGENTS.d1 = [
			agent("a1", "w1"),
			{ ...agent("a2", "w1"), parentId: "a1", cancelled: true },
			{ ...agent("a3", "w1"), parentId: "a1" },
		];
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a2")).toBeVisible();
		const chips = [...screen.baseElement.querySelectorAll('[data-testid="subagent-cancelled"]')];
		expect(chips.map(text)).toEqual(["cancelled"]);
		reset();
	});

	it("flattens a two-level spawn chain under its first spawner, in chain order", async () => {
		AGENTS.d1 = [
			agent("a1", "w1"),
			agent("a5", "w1"),
			spawnedBy("a3", "a2"),
			spawnedBy("a2", "a1"),
		];
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a3")).toBeVisible();
		const rail = screen.baseElement.querySelector('[data-testid="workspace-rail"]');
		const order = [...(rail?.querySelectorAll("a[title]") ?? [])].map((a) =>
			a.getAttribute("title")
		);
		expect(order).toEqual(["Agent a1", "Agent a2", "Agent a3", "Agent a5"]);
		// One connector group, both rows in it at the same step: no staircase.
		const groups = rail?.querySelectorAll('[data-testid="session-children"]');
		expect(groups).toHaveLength(1);
		expect(groups?.[0]?.querySelectorAll('[data-testid="session-row"]')).toHaveLength(2);
		reset();
	});

	it("keeps spawned sessions when subagents are hidden", async () => {
		AGENTS.d1 = [
			agent("a1", "w1"),
			{ ...agent("a2", "w1"), parentId: "a1" },
			spawnedBy("a3", "a1"),
		];
		localStorage.setItem("code.showSubagents", "false");
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a3")).toBeVisible();
		expect(screen.baseElement.querySelector('a[title="Agent a2"]')).toBeNull();
		expect(screen.baseElement.querySelector('a[title="Agent a3"]')).not.toBeNull();
		reset();
	});
});

describe("CodeNavTree machine rows", () => {
	const names = (screen: ReturnType<typeof mount>) =>
		[...screen.baseElement.querySelectorAll('[data-testid="device-row"] a')].map((a) =>
			a.getAttribute("title")
		);

	it("shows a dot, not an 'online' pill: filled when connected, hollow when not", async () => {
		go("");
		const screen = mount([device("d1"), device("d2", { online: false })]);
		await expect.element(screen.getByText("Box d1")).toBeVisible();
		const dots = [...screen.baseElement.querySelectorAll('[data-testid="device-status"]')];
		expect(dots.map((d) => d.getAttribute("data-status"))).toEqual(["online", "offline"]);
		expect(dots[0]?.className).toContain("bg-green-500");
		expect(dots[1]?.className).toContain("border");
		expect(dots[1]?.className).not.toContain("bg-green");
		expect(dots.map((d) => d.getAttribute("aria-label"))).toEqual(["Connected", "Not connected"]);
		expect(screen.getByText("online", { exact: true }).elements()).toHaveLength(0);
		expect(screen.getByText("offline", { exact: true }).elements()).toHaveLength(1);
	});

	it("sorts offline machines to the bottom, dimmed, with when they were last seen", async () => {
		go("");
		const threeHoursAgo = new Date(Date.now() - 3 * 3600_000 - 60_000).toISOString();
		const screen = mount([
			device("d1", { online: false, lastSeenAt: threeHoursAgo }),
			device("d2"),
			device("d3", { online: false }),
			device("d4"),
		]);
		await expect.element(screen.getByText("Box d2")).toBeVisible();
		expect(names(screen)).toEqual(["Box d2", "Box d4", "Box d1", "Box d3"]);
		const rows = [...screen.baseElement.querySelectorAll('[data-testid="device-row"]')];
		expect(rows.map((r) => r.className.includes("opacity-60"))).toEqual([false, false, true, true]);
		const since = [...screen.baseElement.querySelectorAll('[data-testid="offline-since"]')];
		expect(since.map((s) => s.textContent?.trim())).toEqual(["offline 3h", "offline"]);
	});

	it("keeps a pill only for the states that need words", async () => {
		go("");
		const screen = mount([
			device("d1", { credentialState: "expired" }),
			device("d2", { status: "pending" }),
			device("d3", { reenroll: "revoked" }),
		]);
		await expect.element(screen.getByText("Box d1")).toBeVisible();
		await expect.element(screen.getByText("credential expired", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("pending approval", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("access revoked", { exact: true })).toBeVisible();
		// A pending machine keeps its two decisions on the row.
		await expect
			.element(screen.getByRole("button", { name: "Confirm this machine" }))
			.toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Reject this machine" })).toBeVisible();
	});

	it("holds every machine action in one ⋯ menu, Remove last and destructive, and no trash on the row", async () => {
		go("");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Box d1")).toBeVisible();
		expect(screen.getByTitle("Remove this pairing").elements()).toHaveLength(0);
		expect(screen.getByRole("button", { name: "Machine settings" }).elements()).toHaveLength(1);

		await screen.getByRole("button", { name: "Machine settings" }).click();
		await expect.element(screen.getByRole("menuitem", { name: "Remove" })).toBeVisible();
		const items = [...document.querySelectorAll('[role="menuitem"]')];
		expect(items.map((i) => i.textContent?.trim())).toEqual([
			"Add workspace",
			"Profiles",
			"Remove",
		]);
		expect(items[2]?.className).toContain("text-red-600");
		expect(items[0]?.className).not.toContain("text-red-600");

		// Still confirms before anything is removed.
		await screen.getByRole("menuitem", { name: "Remove" }).click();
		await expect.element(screen.getByRole("dialog")).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Revoke pairing" })).toBeVisible();
	});

	it("offers Add workspace from the menu, and not while the machine is offline", async () => {
		go("");
		const screen = mount([device("d1"), device("d2", { online: false })]);
		await expect.element(screen.getByText("Box d1")).toBeVisible();
		await screen.getByRole("button", { name: "Machine settings" }).first().click();
		await screen.getByRole("menuitem", { name: "Add workspace" }).click();
		await expect.element(screen.getByRole("dialog")).toBeVisible();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Machine settings" }).nth(1).click();
		await expect
			.element(screen.getByRole("menuitem", { name: "Add workspace" }))
			.toHaveAttribute("data-disabled");
	});

	it("gives a revoked machine a menu with Remove alone", async () => {
		go("");
		const screen = mount([device("d3", { reenroll: "revoked" })]);
		await expect.element(screen.getByText("Box d3")).toBeVisible();
		await screen.getByRole("button", { name: "Machine settings" }).click();
		const items = [...document.querySelectorAll('[role="menuitem"]')];
		expect(items.map((i) => i.textContent?.trim())).toEqual(["Remove"]);
	});
});

describe("CodeNavTree workspace rows", () => {
	it("shows the folder's name, with the full path as its tooltip and the menu's first line", async () => {
		WORKSPACES.d1 = [
			{
				id: "w1",
				name: "/home/paolo/repos/cloud_sync",
				path: "/home/paolo/repos/cloud_sync",
				isGitRepo: false,
			},
			{ id: "w2", name: "Home - this deployment", path: "/srv/home", isGitRepo: false },
		];
		go("");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("cloud_sync", { exact: true })).toBeVisible();
		expect(screen.baseElement.textContent).not.toContain("/home/paolo/repos");
		const row = screen.getByText("cloud_sync", { exact: true }).element().closest("span.flex");
		expect(row?.getAttribute("title")).toBe("/home/paolo/repos/cloud_sync");
		// A name someone chose is kept.
		await expect.element(screen.getByText("Home - this deployment")).toBeVisible();

		await screen.getByRole("button", { name: "Workspace actions" }).first().click();
		const path = document.querySelector('[data-testid="workspace-path"]');
		expect(path?.textContent?.trim()).toBe("/home/paolo/repos/cloud_sync");
		// Not an action: the first menuitem is the first action after it.
		expect(path?.getAttribute("role")).not.toBe("menuitem");
		const items = [...document.querySelectorAll('[role="menuitem"]')];
		expect(items.map((i) => i.textContent?.trim())).toEqual(["New session", "Rename", "Archive"]);
		WORKSPACES.d1 = [{ id: "w1", name: "alpha", path: "/a", isGitRepo: false }];
	});

	it("keeps ＋ as the visible way to start a session, and the menu has it too", async () => {
		go("");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("alpha")).toBeVisible();
		await screen.getByRole("button", { name: "Start a coding session in this workspace" }).click();
		await expect.element(screen.getByRole("dialog")).toBeVisible();
	});
});

describe("CodeNavTree session state", () => {
	const row = (screen: ReturnType<typeof mount>, id: string) =>
		screen.baseElement.querySelector(`a[title="Agent ${id}"]`) as HTMLElement;

	it("draws running, needs-you and error as icons with words for a screen reader, and idle as nothing", async () => {
		AGENTS.d1 = [
			{ ...agent("a1", "w1"), state: "running" },
			{ ...agent("a2", "w1"), state: "waiting-permission" },
			{ ...agent("a3", "w1"), state: "error" },
			{ ...agent("a4", "w1"), state: "idle" },
			{ ...agent("a5", "w1"), state: "done" },
		];
		go("");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a5")).toBeVisible();
		const state = (id: string) => row(screen, id).querySelector("[data-state]");
		expect(state("a1")?.getAttribute("data-state")).toBe("running");
		expect(state("a1")?.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
		expect(state("a1")?.textContent?.trim()).toBe("Running");
		expect(state("a2")?.getAttribute("data-state")).toBe("needs-you");
		expect(state("a2")?.className).toContain("text-amber");
		expect(state("a2")?.textContent?.trim()).toBe("Needs you");
		expect(state("a2")?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
		expect(state("a3")?.getAttribute("data-state")).toBe("error");
		expect(state("a3")?.textContent?.trim()).toBe("Failed");
		expect(state("a4")).toBeNull();
		expect(state("a5")).toBeNull();
		// The old status dot is gone.
		expect(row(screen, "a4").querySelector(".rounded-full")).toBeNull();
		AGENTS.d1 = [agent("a1", "w1"), agent("a2", "w1")];
	});

	it("marks a parent amber while one of its subagents waits", async () => {
		AGENTS.d1 = [
			agent("a1", "w1"),
			{ ...agent("a2", "w1"), parentId: "a1", state: "waiting-permission" },
		];
		go("");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a2")).toBeVisible();
		expect(row(screen, "a1").querySelector("[data-state]")?.getAttribute("data-state")).toBe(
			"needs-you"
		);
		AGENTS.d1 = [agent("a1", "w1"), agent("a2", "w1")];
	});

	it("right-aligns a compact time of last activity, and leaves it out under a minute", async () => {
		AGENTS.d1 = [
			{ ...agent("a1", "w1"), updatedAt: new Date(Date.now() - 2 * 3600_000 - 5000).toISOString() },
			{ ...agent("a2", "w1"), updatedAt: new Date(Date.now() - 10_000).toISOString() },
		];
		go("");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a2")).toBeVisible();
		expect(row(screen, "a1").querySelector('[data-testid="session-age"]')?.textContent).toBe("2h");
		expect(row(screen, "a2").querySelector('[data-testid="session-age"]')).toBeNull();
		AGENTS.d1 = [agent("a1", "w1"), agent("a2", "w1")];
	});
});

describe("CodeNavTree row actions", () => {
	const opacity = (el: Element | null | undefined) => (el ? getComputedStyle(el).opacity : "");

	it("reveals ＋ and ⋯ on hover and keyboard focus within the row, on a pointer that hovers", async () => {
		go("");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a1", { exact: true })).toBeVisible();
		const rowEl = screen.baseElement.querySelector('[data-testid="session-row"]') as HTMLElement;
		const kebab = rowEl.querySelector(".nav-reveal");
		expect(kebab?.getAttribute("aria-label")).toBe("Session actions");
		expect(opacity(kebab)).toBe("0");

		(rowEl.querySelector("a") as HTMLElement).focus();
		expect(opacity(kebab)).toBe("1");
		(document.activeElement as HTMLElement).blur();
		expect(opacity(kebab)).toBe("0");

		// The machine and workspace rows carry both, tagged for the touch rule.
		const device0 = screen.baseElement.querySelector('[data-testid="device-row"]') as HTMLElement;
		expect(device0.querySelectorAll(".nav-reveal.nav-plus")).toHaveLength(1);
		expect(device0.querySelectorAll(".nav-kebab")).toHaveLength(1);
		// Icon-only buttons are named.
		for (const button of screen.baseElement.querySelectorAll(".nav-reveal")) {
			expect(button.getAttribute("aria-label")).toBeTruthy();
		}
	});

	it("opens the row's menu on a touch long-press, and not on a mouse press", async () => {
		go("");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a1", { exact: true })).toBeVisible();
		const rowEl = screen.baseElement.querySelector('[data-testid="session-row"]') as HTMLElement;
		const press = (pointerType: string) =>
			rowEl.dispatchEvent(
				new PointerEvent("pointerdown", { pointerType, bubbles: true, clientX: 5, clientY: 5 })
			);

		press("mouse");
		await new Promise((resolve) => setTimeout(resolve, 650));
		expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);

		press("touch");
		await expect.element(screen.getByRole("menuitem", { name: "Rename" })).toBeVisible();
	});

	it("does not open it when the finger lifts or moves away before the hold", async () => {
		go("");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a1", { exact: true })).toBeVisible();
		const rowEl = screen.baseElement.querySelector('[data-testid="session-row"]') as HTMLElement;
		rowEl.dispatchEvent(
			new PointerEvent("pointerdown", {
				pointerType: "touch",
				bubbles: true,
				clientX: 5,
				clientY: 5,
			})
		);
		rowEl.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 650));
		expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);

		rowEl.dispatchEvent(
			new PointerEvent("pointerdown", {
				pointerType: "touch",
				bubbles: true,
				clientX: 5,
				clientY: 5,
			})
		);
		rowEl.dispatchEvent(
			new PointerEvent("pointermove", {
				pointerType: "touch",
				bubbles: true,
				clientX: 60,
				clientY: 5,
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 650));
		expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
	});
});

describe("CodeNavTree legacy machines", () => {
	it("marks the row of a machine found to predate ceilings, with the enroll command, and only that one", async () => {
		for (const id of Object.keys(codeLegacyMachines)) delete codeLegacyMachines[id];
		codeLegacyMachines.d1 = true;
		codeLegacyMachines.d2 = false;
		go("");
		const screen = mount();
		await expect.element(screen.getByText("Box d1")).toBeVisible();
		const flags = screen.getByTestId("legacy-machine-row-flag");
		await expect.element(flags).toBeVisible();
		expect(flags.elements()).toHaveLength(1);
		await expect.element(flags).toHaveTextContent("predates ceilings");
		await expect.element(flags).toHaveTextContent("One re-enroll tightens it");
		await expect.element(flags).toHaveTextContent("enroll");
		for (const id of Object.keys(codeLegacyMachines)) delete codeLegacyMachines[id];
	});

	it("shows no flag on a tree where no machine has been found legacy", async () => {
		for (const id of Object.keys(codeLegacyMachines)) delete codeLegacyMachines[id];
		go("");
		const screen = mount();
		await expect.element(screen.getByText("Box d1")).toBeVisible();
		expect(screen.getByTestId("legacy-machine-row-flag").elements()).toHaveLength(0);
	});
});

describe("CodeNavTree scheduled actions", () => {
	function withSchedules(on: boolean) {
		Object.assign(livePage.data, { codeSchedulesEnabled: on });
	}

	it("offers a Schedules row above the devices only when the deployment has them on", async () => {
		withSchedules(false);
		go("");
		const off = mount();
		await expect.element(off.getByText("Box d1")).toBeVisible();
		expect(off.getByTestId("schedules-link").elements()).toHaveLength(0);
		off.unmount();

		withSchedules(true);
		const on = mount();
		const link = on.getByTestId("schedules-link");
		await expect.element(link).toBeVisible();
		await expect.element(link).toHaveAttribute("href", "/code?view=schedules");
		withSchedules(false);
	});

	it("highlights the Schedules row alone while the schedules pages are open, whatever they prefill", async () => {
		withSchedules(true);
		go("?view=schedules&new=1&device=d1&ws=w1&agent=a1");
		const screen = mount();
		await expect.element(screen.getByText("Agent a1")).toBeVisible();
		expect(screen.getByTestId("schedules-link").element().className).toContain("font-semibold");
		const row = screen.getByRole("link", { name: "Agent a1" }).element();
		expect(row.className).not.toContain("font-semibold");
		withSchedules(false);
	});

	it("opens the editor prefilled with machine, workspace and session from a session's menu", async () => {
		withSchedules(true);
		go("");
		const screen = mount();
		await expect.element(screen.getByText("Agent a1")).toBeVisible();
		appNavigation().goto.mockClear();
		await screen.getByRole("button", { name: "Session actions" }).first().click();
		await screen.getByRole("menuitem", { name: "Schedule this…" }).click();
		expect(appNavigation().goto).toHaveBeenCalledWith(
			"/code?view=schedules&new=1&device=d1&ws=w1&agent=a1"
		);
		withSchedules(false);
	});

	it("has no Schedule this… item when they are off", async () => {
		withSchedules(false);
		go("");
		const screen = mount();
		await expect.element(screen.getByText("Agent a1")).toBeVisible();
		await screen.getByRole("button", { name: "Session actions" }).first().click();
		await expect.element(screen.getByRole("menuitem", { name: "Rename" })).toBeVisible();
		expect(screen.getByRole("menuitem", { name: "Schedule this…" }).elements()).toHaveLength(0);
	});

	it("marks a session a schedule started, and no other", async () => {
		AGENTS.d1 = [
			{ ...agent("a1", "w1"), title: "Nightly · 2026-10-08 09:00" },
			{ ...agent("a2", "w1"), title: "Fix the thing" },
		];
		go("");
		const screen = mount();
		await expect.element(screen.getByText("Fix the thing")).toBeVisible();
		expect(screen.getByTestId("scheduled-badge").elements()).toHaveLength(1);
		AGENTS.d1 = [agent("a1", "w1"), agent("a2", "w1")];
	});
});

describe("CodeNavTree session Permissions menu", () => {
	function rulesFor(approvals: number) {
		return {
			mode: "ask",
			rules: [{ permission: "*", pattern: "*", action: "ask", source: "cerea" }],
			savedApprovals: Array.from({ length: approvals }, (_, i) => ({
				id: `ex_${i}`,
				permission: "bash",
				patterns: ["npm test"],
				removable: true,
			})),
			ceiling: {},
		};
	}

	it("opens the dialog for the row whose menu it came from, selected or not", async () => {
		// a1 is the selection; the menu is a2's.
		apiMock.getPermissionRules.mockImplementation(async (_device: string, agentId: string) =>
			rulesFor(agentId === "a2" ? 2 : 0)
		);
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount();
		await expect.element(screen.getByText("Agent a1", { exact: true })).toBeVisible();

		await screen.getByRole("button", { name: "Session actions" }).nth(1).click();
		await screen.getByRole("menuitem", { name: "Permissions…" }).click();
		await expect
			.element(screen.getByRole("heading", { name: "Permissions — Agent a2" }))
			.toBeVisible();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		// The dialog read THAT session's rules, not the selection's.
		expect(apiMock.getPermissionRules).toHaveBeenCalledWith("d1", "a2");
		expect(screen.getByTestId("permission-exception-item").elements()).toHaveLength(2);

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await expect.element(screen.getByTestId("permissions-detail")).not.toBeInTheDocument();
	});

	it("opens a machine's delegate profiles from its settings menu, for that machine", async () => {
		apiMock.getDelegateProfiles.mockResolvedValue({
			default: "fast",
			profiles: [{ name: "fast", model: "gw/fast" }],
		});
		apiMock.listProviderModels.mockResolvedValue({ models: [{ id: "gw/fast", label: "Fast" }] });
		go("?device=d1&ws=w1");
		const screen = mount([
			device("d1", {
				backends: [{ id: "opencode", version: "1", capabilities: {} }],
				machine: { capabilities: { delegateProfiles: true } },
			}),
		]);
		await expect.element(screen.getByText("alpha")).toBeVisible();
		await screen.getByRole("button", { name: "Machine settings" }).click();
		await screen.getByRole("menuitem", { name: "Profiles" }).click();
		await expect.element(screen.getByRole("heading", { name: "Delegate profiles" })).toBeVisible();
		await expect.element(screen.getByLabelText("Profile 1 name")).toHaveValue("fast");
		expect(apiMock.getDelegateProfiles).toHaveBeenCalledWith("d1");
	});

	it("folds what a phone keyboard types into a valid profile name", async () => {
		apiMock.getDelegateProfiles.mockResolvedValue({ default: null, profiles: [] });
		apiMock.listProviderModels.mockResolvedValue({ models: [{ id: "gw/fast", label: "Fast" }] });
		go("?device=d1&ws=w1");
		const screen = mount([
			device("d1", {
				backends: [{ id: "opencode", version: "1", capabilities: {} }],
				machine: { capabilities: { delegateProfiles: true } },
			}),
		]);
		await expect.element(screen.getByText("alpha")).toBeVisible();
		await screen.getByRole("button", { name: "Machine settings" }).click();
		await screen.getByRole("menuitem", { name: "Profiles" }).click();
		await screen.getByRole("button", { name: "Add profile" }).click();
		const name = screen.getByLabelText("Profile 1 name");
		await expect.element(name).toHaveAttribute("autocapitalize", "none");
		// A suggestion's leading space and the keyboard's capital, as on Android.
		await name.fill(" Default");
		await expect.element(name).toHaveValue("default");
		await name.fill("Code Review");
		await expect.element(name).toHaveValue("code-review");
		expect(screen.getByTestId("profiles-invalid").elements()).toHaveLength(0);
	});

	it("says to update galopin in the profiles dialog of a machine without the capability", async () => {
		apiMock.getDelegateProfiles.mockReset();
		go("?device=d1&ws=w1");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("alpha")).toBeVisible();
		await screen.getByRole("button", { name: "Machine settings" }).click();
		await screen.getByRole("menuitem", { name: "Profiles" }).click();
		await expect
			.element(screen.getByTestId("profiles-unavailable"))
			.toHaveTextContent("update galopin on this machine");
		expect(apiMock.getDelegateProfiles).not.toHaveBeenCalled();
	});

	it("has no Permissions… item on a subagent row", async () => {
		AGENTS.d1 = [agent("a1", "w1"), { ...agent("a2", "w1"), parentId: "a1" }];
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount();
		await expect.element(screen.getByText("Agent a2")).toBeVisible();

		await screen.getByRole("button", { name: "Session actions" }).nth(1).click();
		expect(screen.getByRole("menuitem", { name: "Permissions…" }).elements()).toHaveLength(0);
		screen.unmount();

		// The ordinary session's own menu still carries it.
		AGENTS.d1 = [agent("a1", "w1"), agent("a2", "w1")];
		const second = mount();
		await expect.element(second.getByText("Agent a1", { exact: true })).toBeVisible();
		await second.getByRole("button", { name: "Session actions" }).first().click();
		await expect.element(second.getByRole("menuitem", { name: "Permissions…" })).toBeVisible();
		AGENTS.d1 = [agent("a1", "w1"), agent("a2", "w1")];
	});

	it("shows the re-enroll content for a machine that predates ceilings", async () => {
		apiMock.getPermissionRules.mockResolvedValue({
			rules: [{ permission: "*", pattern: "*", action: "allow", source: "opencode" }],
			savedApprovals: [],
			ceiling: {},
		});
		const legacyPolicy = { workspaceRoots: [], allowFreeModels: false, permission: { max: {} } };
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([device("d1", { policy: legacyPolicy }), device("d2")]);
		await expect.element(screen.getByText("Agent a1", { exact: true })).toBeVisible();

		await screen.getByRole("button", { name: "Session actions" }).first().click();
		await screen.getByRole("menuitem", { name: "Permissions…" }).click();
		await expect.element(screen.getByTestId("legacy-machine-flag")).toBeVisible();
		await expect
			.element(screen.getByTestId("legacy-machine-flag"))
			.toHaveTextContent("Re-enroll this machine to set limits");
	});
});
