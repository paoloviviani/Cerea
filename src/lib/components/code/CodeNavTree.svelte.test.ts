import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushSync } from "svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import CodeNavTree from "./CodeNavTree.svelte";
import { livePage } from "./codeNavPage.svelte";
import { CODE_TREE_COLLAPSE_KEY } from "$lib/utils/codeTreeCollapse";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";

/**
 * The daemon side is a fake; what is under test is the tree's own decisions:
 * which rows honour their collapse state, when navigation reveals a folded
 * row, and where the nesting guides are drawn.
 */
const apiMock = vi.hoisted(() => ({
	listDevices: vi.fn(),
	listWorkspaces: vi.fn(),
	listAgents: vi.fn(),
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
	it("lists a spawned session as its own top-level row, with a ↳ from link to its spawner", async () => {
		AGENTS.d1 = [
			agent("a1", "w1"),
			{ ...agent("a2", "w1"), spawnedBy: { sessionId: "a1", title: "Agent a1 (then)" } },
			// A spawner that is gone: the title it was created with still reads.
			{ ...agent("a4", "w1"), spawnedBy: { sessionId: "gone", title: "Old planner" } },
		];
		go("?device=d1&ws=w1&agent=a1");
		const screen = mount();
		await expect.element(screen.getByText("Agent a2")).toBeVisible();

		const froms = [...screen.baseElement.querySelectorAll('[data-testid="spawned-from"]')];
		expect(froms.map((el) => el.textContent?.replace(/\s+/g, " ").trim())).toEqual([
			"↳ from Agent a1",
			"↳ from Old planner",
		]);
		// Linked when the spawner is listed, plain text when it is not; never a
		// subagent badge, since a spawned session has no parent edge.
		expect(froms[0]?.getAttribute("href")).toContain("agent=a1");
		expect(froms[0]?.getAttribute("href")).toContain("ws=w1");
		expect(froms[1]?.tagName).toBe("P");
		expect(screen.baseElement.querySelectorAll('[data-testid="subagent-badge"]')).toHaveLength(0);
		AGENTS.d1 = [agent("a1", "w1"), agent("a2", "w1")];
	});
});
