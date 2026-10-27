import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushSync } from "svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import CodeNavTree from "./CodeNavTree.svelte";
import NavFooter from "$lib/components/nav/NavFooter.svelte";
import { livePage } from "./codeNavPage.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import {
	bindCodeCacheOwner,
	clearCodePanelCache,
	codeTreeCache,
} from "$lib/stores/codeTreeCache.svelte";

/**
 * The sidebar's machines and sessions outlive the tree component: leaving
 * /code and coming back draws the cached rows at once and re-reads in the
 * background, only once they are old, folding the answer in place.
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

const device = { id: "d1", name: "Box d1", status: "paired", online: true };
const workspace = { id: "w1", name: "alpha", path: "/a", isGitRepo: false };
function agent(id: string, title = `Agent ${id}`) {
	return {
		id,
		workspaceId: "w1",
		title,
		provider: "opencode",
		state: "idle",
		updatedAt: "2026-09-30T00:00:00Z",
		modeId: null,
		modelId: null,
	};
}

let agents: ReturnType<typeof agent>[];

const settle = () => new Promise((r) => setTimeout(r, 60));

/** Ages the cache past the interval, as a long absence would. */
function age() {
	codeDeviceList.fetchedAt = 1;
	for (const id of Object.keys(codeTreeCache.fetchedAt)) codeTreeCache.fetchedAt[id] = 1;
}

beforeEach(() => {
	localStorage.clear();
	clearCodePanelCache();
	livePage.url = new URL("http://localhost:3000/code");
	agents = [agent("a1"), agent("a2")];
	apiMock.listDevices.mockReset().mockResolvedValue({ devices: [{ ...device }] });
	apiMock.listWorkspaces.mockReset().mockImplementation(async () => ({ workspaces: [workspace] }));
	apiMock.listAgents.mockReset().mockImplementation(async () => ({
		agents: agents.map((a) => ({ ...a })),
	}));
	apiMock.getPermissionRules.mockReset().mockRejectedValue({ status: 404 });
});

describe("CodeNavTree keeps its list between visits", () => {
	it("returning within the interval asks for nothing and never draws an empty or loading tree", async () => {
		const first = renderWithApp(CodeNavTree);
		await expect.element(first.getByText("Agent a1")).toBeVisible();
		first.unmount();
		apiMock.listDevices.mockClear();
		apiMock.listWorkspaces.mockClear();
		apiMock.listAgents.mockClear();

		const second = renderWithApp(CodeNavTree);
		flushSync();
		// The very first frame: rows are there, no loading text, no empty state.
		const text = second.baseElement.textContent ?? "";
		expect(text).toContain("Agent a1");
		expect(text).toContain("Agent a2");
		expect(text).not.toMatch(/Loading/i);

		await settle();
		expect(apiMock.listDevices).not.toHaveBeenCalled();
		expect(apiMock.listWorkspaces).not.toHaveBeenCalled();
		expect(apiMock.listAgents).not.toHaveBeenCalled();
	});

	it("returning after the interval shows the cached rows at once, then updates only the changed one", async () => {
		const first = renderWithApp(CodeNavTree);
		await expect.element(first.getByText("Agent a1")).toBeVisible();
		first.unmount();
		age();
		const cachedA1 = codeTreeCache.trees.d1.agents[0];
		const cachedA2 = codeTreeCache.trees.d1.agents[1];
		apiMock.listDevices.mockClear();
		// One session is renamed while the person was away.
		agents = [agent("a1"), agent("a2", "Agent a2 renamed")];

		const second = renderWithApp(CodeNavTree);
		flushSync();
		expect(second.baseElement.textContent).toContain("Agent a1");
		expect(second.baseElement.textContent).not.toMatch(/Loading/i);
		const a1Row = second.getByText("Agent a1").element();
		const a2Row = second.getByText("Agent a2", { exact: true }).element();

		await expect.element(second.getByText("Agent a2 renamed")).toBeVisible();
		expect(apiMock.listDevices).toHaveBeenCalledTimes(1);

		// The unchanged row is the same DOM node and the same cached object; the
		// changed row is the same node too (keyed by id), with new text.
		expect(second.getByText("Agent a1").element()).toBe(a1Row);
		expect(a1Row.isConnected).toBe(true);
		expect(codeTreeCache.trees.d1.agents[0]).toBe(cachedA1);
		expect(codeTreeCache.trees.d1.agents[1]).not.toBe(cachedA2);
		expect(second.getByText("Agent a2 renamed").element()).toBe(a2Row);
	});

	it("a failed refresh keeps the cached rows and says the machine did not answer", async () => {
		const first = renderWithApp(CodeNavTree);
		await expect.element(first.getByText("Agent a1")).toBeVisible();
		first.unmount();
		age();
		apiMock.listAgents.mockRejectedValue(new Error("boom"));

		const second = renderWithApp(CodeNavTree);
		await expect.element(second.getByText("Offline.")).toBeVisible();
		await expect.element(second.getByText("Agent a1")).toBeVisible();
		await expect.element(second.getByText("Agent a2")).toBeVisible();
		expect(codeTreeCache.trees.d1.agents).toHaveLength(2);
	});
});

describe("the cache belongs to one person", () => {
	it("signing out drops the machines and sessions", async () => {
		const screen = renderWithApp(CodeNavTree);
		await expect.element(screen.getByText("Agent a1")).toBeVisible();
		screen.unmount();
		expect(Object.keys(codeTreeCache.trees)).toEqual(["d1"]);
		expect(codeDeviceList.devices).toHaveLength(1);

		const footer = renderWithApp(NavFooter, { user: { username: "ada" } } as never);
		const form = footer.baseElement.querySelector("form");
		form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

		expect(codeTreeCache.trees).toEqual({});
		expect(codeDeviceList.devices).toEqual([]);
		expect(codeDeviceList.loading).toBe(true);
		footer.unmount();
	});

	it("a different account never sees the previous one's machines", async () => {
		bindCodeCacheOwner("ada");
		const screen = renderWithApp(CodeNavTree);
		await expect.element(screen.getByText("Agent a1")).toBeVisible();
		screen.unmount();

		bindCodeCacheOwner("grace");
		expect(codeTreeCache.trees).toEqual({});
		expect(codeDeviceList.devices).toEqual([]);
		expect(codeTreeCache.owner).toBe("grace");
	});
});
