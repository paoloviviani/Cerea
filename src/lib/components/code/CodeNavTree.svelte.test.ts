import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushSync } from "svelte";
import { appNavigation, renderWithApp } from "$lib/components/__tests__/renderWithApp";
import CodeNavTree from "./CodeNavTree.svelte";
import { livePage } from "./codeNavPage.svelte";
import { CODE_TREE_COLLAPSE_KEY } from "$lib/utils/codeTreeCollapse";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
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
		expect(link().className).not.toContain("font-semibold");
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
	it("draws a rail under each expanded paired row and nowhere else", async () => {
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([
			device("d1"),
			device("d2"),
			device("d3", { status: "pending" }),
			device("d4", { reenroll: "revoked" }),
		]);
		await expect.element(screen.getByText("Agent a1")).toBeVisible();
		await expect.element(screen.getByText("Agent a3")).toBeVisible();

		// d1 and d2 each: one device rail, one workspace rail. The pending and
		// revoked rows have no subtree to guide.
		expect(rails(screen, "device")).toHaveLength(2);
		expect(rails(screen, "workspace")).toHaveLength(2);
		expect(rails(screen, "device")[0]?.className).toContain("border-l");

		await screen.getByRole("button", { name: "Collapse alpha" }).click();
		expect(rails(screen, "workspace")).toHaveLength(1);

		await screen.getByRole("button", { name: "Collapse Box d2" }).click();
		expect(rails(screen, "device")).toHaveLength(1);
		expect(rails(screen, "workspace")).toHaveLength(0);
	});
});

describe("CodeNavTree subagent rails", () => {
	it("puts a subagent in a rail of its own, and leaves ordinary sessions out of one", async () => {
		AGENTS.d1 = [agent("a1", "w1"), { ...agent("a2", "w1"), parentId: "a1" }];
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount();
		await expect.element(screen.getByText("Agent a2")).toBeVisible();
		const subRails = screen.baseElement.querySelectorAll('[data-testid="subagent-rail"]');
		expect(subRails).toHaveLength(1);
		expect(subRails[0]?.className).toContain("border-l");
		expect(subRails[0]?.textContent).toContain("Agent a2");
		// a1 is an ordinary session, outside it (its name appears only in the
		// subagent's own "↳ from" line).
		expect(subRails[0]?.querySelector('a[title="Agent a1"]')).toBeNull();
		// Nested inside the workspace's rail.
		expect(subRails[0]?.closest('[data-testid="workspace-rail"]')).not.toBeNull();
		AGENTS.d1 = [agent("a1", "w1"), agent("a2", "w1")];
	});
});

describe("CodeNavTree spawned sessions", () => {
	const reset = () => (AGENTS.d1 = [agent("a1", "w1"), agent("a2", "w1")]);
	const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim();

	it("marks a spawned session with a provenance chip, not the subagent's ↳ from", async () => {
		AGENTS.d1 = [
			agent("a1", "w1"),
			{ ...agent("a2", "w1"), spawnedBy: { sessionId: "a1", title: "Agent a1 (then)" } },
			{ ...agent("a3", "w1"), parentId: "a1" },
			// A spawner that is gone: the title it was created with still reads.
			{ ...agent("a4", "w1"), spawnedBy: { sessionId: "gone", title: "Old planner" } },
		];
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a2")).toBeVisible();

		const froms = [...screen.baseElement.querySelectorAll('[data-testid="spawned-from"]')];
		expect(froms.map(text)).toEqual(["spawned by Agent a1", "spawned by Old planner (gone)"]);
		// Linked when the spawner is listed; muted plain text when it is gone.
		expect(froms[0]?.getAttribute("href")).toContain("agent=a1");
		expect(froms[0]?.getAttribute("href")).toContain("ws=w1");
		expect(froms[0]?.querySelector("svg")).not.toBeNull();
		expect(froms[1]?.tagName).toBe("P");
		expect(froms[1]?.className).toContain("text-gray-400");
		// The subagent keeps its ↳, and only it: its parentage is real.
		const subFrom = screen.baseElement.querySelectorAll('[data-testid="subagent-from"]');
		expect(subFrom).toHaveLength(1);
		expect(text(subFrom[0])).toBe("↳ from Agent a1");
		expect(screen.baseElement.textContent).not.toContain("↳ from Old planner");
		// Only the real subagent carries a badge, and only it sits in a rail.
		expect(screen.baseElement.querySelectorAll('[data-testid="subagent-badge"]')).toHaveLength(1);
		expect(screen.baseElement.querySelectorAll('[data-testid="subagent-rail"]')).toHaveLength(1);
		reset();
	});

	it("sorts spawned sessions after their spawner along a two-level chain, at one indent", async () => {
		AGENTS.d1 = [
			agent("a1", "w1"),
			agent("a5", "w1"),
			{ ...agent("a3", "w1"), spawnedBy: { sessionId: "a2", title: "Agent a2" } },
			{ ...agent("a2", "w1"), spawnedBy: { sessionId: "a1", title: "Agent a1" } },
		];
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a3")).toBeVisible();
		const rail = screen.baseElement.querySelector('[data-testid="workspace-rail"]');
		const order = [...(rail?.querySelectorAll("a[title]") ?? [])].map((a) =>
			a.getAttribute("title")
		);
		expect(order).toEqual(["Agent a1", "Agent a2", "Agent a3", "Agent a5"]);
		// Adjacency, not containment: no rail around the spawned rows.
		expect(rail?.querySelectorAll('[data-testid="subagent-rail"]')).toHaveLength(0);
		reset();
	});

	it("shows 'spawned N' on the spawner, as information: a menu of links, no disclosure", async () => {
		AGENTS.d1 = [
			agent("a1", "w1"),
			{ ...agent("a2", "w1"), spawnedBy: { sessionId: "a1", title: "Agent a1" } },
			{ ...agent("a3", "w1"), spawnedBy: { sessionId: "a1", title: "Agent a1" } },
		];
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a3")).toBeVisible();
		const counts = screen.baseElement.querySelectorAll('[data-testid="spawned-count"]');
		expect(counts).toHaveLength(1);
		expect(text(counts[0])).toBe("spawned 2");
		expect(counts[0]?.closest('[data-testid="workspace-rail"]')).not.toBeNull();
		// Not collapsible: the spawned rows stay listed whatever is clicked.
		await screen.getByTestId("spawned-count").click();
		expect(screen.baseElement.querySelectorAll('a[title^="Agent a"]')).toHaveLength(3);
		reset();
	});

	it("keeps spawned sessions when subagents are hidden, and when the spawner is gone", async () => {
		AGENTS.d1 = [
			agent("a1", "w1"),
			{ ...agent("a2", "w1"), parentId: "a1" },
			{ ...agent("a3", "w1"), spawnedBy: { sessionId: "a1", title: "Agent a1" } },
		];
		localStorage.setItem("code.showSubagents", "false");
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a3")).toBeVisible();
		expect(screen.baseElement.querySelector('a[title="Agent a2"]')).toBeNull();
		expect(screen.baseElement.querySelector('a[title="Agent a3"]')).not.toBeNull();
		reset();
	});

	it("leaves a spawned session listed, marked gone, once its spawner is archived or deleted", async () => {
		AGENTS.d1 = [
			{ ...agent("a3", "w1"), spawnedBy: { sessionId: "a1", title: "Agent a1 (then)" } },
			agent("a2", "w1"),
		];
		go("?device=d1&ws=w1&agent=a2");
		const screen = mount([device("d1")]);
		await expect.element(screen.getByText("Agent a3")).toBeVisible();
		expect(text(screen.baseElement.querySelector('[data-testid="spawned-from"]'))).toBe(
			"spawned by Agent a1 (then) (gone)"
		);
		expect(screen.baseElement.querySelector('[data-testid="spawned-count"]')).toBeNull();
		reset();
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

	it("offers a Schedules row under the devices only when the deployment has them on", async () => {
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

describe("CodeNavTree Permissions item", () => {
	const ASK_RULES = {
		mode: "ask",
		rules: [{ permission: "*", pattern: "*", action: "ask", source: "cerea" }],
		savedApprovals: [],
		ceiling: {},
	};

	function withSchedules(on: boolean) {
		Object.assign(livePage.data, { codeSchedulesEnabled: on });
	}

	it("shows the item only with a selected session whose machine answers permission.rules", async () => {
		withSchedules(true);
		apiMock.getPermissionRules.mockResolvedValue(ASK_RULES);

		go("?device=d1&ws=w1");
		const bare = mount();
		await expect.element(bare.getByText("Box d1")).toBeVisible();
		expect(bare.getByTestId("permissions-item").elements()).toHaveLength(0);
		bare.unmount();

		go("?device=d1&ws=w1&agent=a1");
		const screen = mount();
		const item = screen.getByTestId("permissions-item");
		await expect.element(item).toBeVisible();
		await expect.element(item).toHaveTextContent("Permissions");
		withSchedules(false);
	});

	it("stays hidden when the machine predates the op (404), and on the schedules pages", async () => {
		withSchedules(true);
		go("?device=d1&ws=w1&agent=a1");
		const stale = mount();
		await expect.element(stale.getByText("Agent a1")).toBeVisible();
		expect(stale.getByTestId("permissions-item").elements()).toHaveLength(0);
		stale.unmount();

		go("?view=schedules&device=d1&ws=w1&agent=a1");
		const prefilled = mount();
		await expect.element(prefilled.getByText("Agent a1")).toBeVisible();
		expect(prefilled.getByTestId("permissions-item").elements()).toHaveLength(0);
		withSchedules(false);
	});

	it("carries the session's switch word and the exceptions count", async () => {
		withSchedules(true);
		AGENTS.d1 = [{ ...agent("a1", "w1"), permissionMode: "allow" }, agent("a2", "w1")];
		apiMock.getPermissionRules.mockResolvedValue({
			...ASK_RULES,
			savedApprovals: [
				{ id: "ex_1", permission: "bash", patterns: ["npm test"], removable: true },
				{ id: "ex_2", permission: "edit", patterns: ["src/**"], removable: true },
			],
		});
		const enrolled = {
			workspaceRoots: [],
			allowFreeModels: false,
			permission: { max: { bash: "ask" } },
		};
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([device("d1", { policy: enrolled }), device("d2")]);
		const item = screen.getByTestId("permissions-item");
		await expect.element(item).toBeVisible();
		await expect.element(item).toHaveTextContent("Allow");
		await expect.element(item).toHaveTextContent("2");
		AGENTS.d1 = [agent("a1", "w1"), agent("a2", "w1")];
		withSchedules(false);
	});

	it("flags a pre-ceilings machine with the amber warning instead of the switch", async () => {
		withSchedules(true);
		apiMock.getPermissionRules.mockResolvedValue({
			rules: [{ permission: "*", pattern: "*", action: "allow", source: "opencode" }],
			savedApprovals: [],
			ceiling: {},
		});
		const legacyPolicy = { workspaceRoots: [], allowFreeModels: false, permission: { max: {} } };
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount([device("d1", { policy: legacyPolicy }), device("d2")]);
		const item = screen.getByTestId("permissions-item");
		await expect.element(item).toBeVisible();
		await expect.element(screen.getByTitle("Re-enroll this machine to set limits.")).toBeVisible();
		withSchedules(false);
	});

	it("opens the detail in a dialog and closes it again", async () => {
		withSchedules(true);
		apiMock.getPermissionRules.mockResolvedValue(ASK_RULES);
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount();
		const item = screen.getByTestId("permissions-item");
		await expect.element(item).toBeVisible();
		expect(screen.getByTestId("permissions-detail").elements()).toHaveLength(0);
		await item.click();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await expect.element(screen.getByTestId("permission-rows")).toBeVisible();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await expect.element(screen.getByTestId("permissions-detail")).not.toBeInTheDocument();
		// The row stays, closed.
		await expect.element(screen.getByTestId("permissions-item")).toBeVisible();
		withSchedules(false);
	});
});
