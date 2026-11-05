import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { flushSync } from "svelte";
import { writable } from "svelte/store";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import ProjectsBranch from "./ProjectsBranch.svelte";
import NavFooter from "./NavFooter.svelte";
import {
	clearProjectsCache,
	projectsTreeCache,
	PROJECTS_CACHE_STALE_MS,
} from "$lib/stores/projectsTreeCache.svelte";
import { PROJECTS_TREE_OPEN_KEY } from "$lib/utils/projectsTreeOpen";
import { CONVERSATIONS_CONTEXT_KEY, newConversationsStore } from "$lib/stores/conversations.svelte";
import { ACTIVE_GENERATIONS_CONTEXT_KEY } from "$lib/stores/activeGenerations.svelte";

/**
 * The Projects tree outlives the branch component: switching to the Agents
 * panel and back draws the cached projects and chats in the first frame and
 * re-reads in the background, only once they are old, folding the answer in
 * place.
 */
function mkProject(id: string, name: string) {
	return {
		id,
		name,
		description: "",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: false,
		retrievalLimit: 6,
		owned: true,
		shares: [],
		conversationCount: 1,
		othersCount: 0,
		updatedAt: "2026-10-01T00:00:00Z",
	};
}
const chat = (id: string, title: string) => ({
	id,
	title,
	model: "m",
	updatedAt: "2026-10-01T00:00:00Z",
});

let projects: ReturnType<typeof mkProject>[];
let chats: ReturnType<typeof chat>[];
let fetched: string[];

const context = () => ({
	context: new Map<string, unknown>([
		["settings", writable({ activeModel: "m" })],
		[CONVERSATIONS_CONTEXT_KEY, newConversationsStore()],
		[ACTIVE_GENERATIONS_CONTEXT_KEY, { has: () => false, setRunning: () => undefined }],
	]),
});
const mount = () =>
	renderWithApp(
		ProjectsBranch,
		{},
		{ page: { params: {}, data: { models: [{ id: "m" }] } }, ...context() }
	);
const settle = () => new Promise((r) => setTimeout(r, 60));

beforeEach(() => {
	clearProjectsCache();
	localStorage.setItem(PROJECTS_TREE_OPEN_KEY, JSON.stringify({ branch: true, projects: ["p1"] }));
	projects = [mkProject("p1", "Mortgage")];
	chats = [chat("c1", "First chat"), chat("c2", "Second chat")];
	fetched = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL) => {
			const href = String(url);
			fetched.push(href);
			if (href.endsWith("/api/v2/projects"))
				return new Response(JSON.stringify({ data: projects }), { status: 200 });
			if (href.endsWith("/conversations"))
				return new Response(JSON.stringify({ data: chats, othersCount: 0 }), { status: 200 });
			throw new Error(`unexpected fetch ${href}`);
		})
	);
});
afterEach(() => {
	localStorage.removeItem(PROJECTS_TREE_OPEN_KEY);
	vi.unstubAllGlobals();
});

describe("ProjectsBranch keeps its list between visits", () => {
	it("returning inside the window asks for nothing and never draws a loading row", async () => {
		const first = mount();
		await expect.element(first.getByText("First chat")).toBeVisible();
		first.unmount();
		fetched.length = 0;

		const second = mount();
		flushSync();
		const text = second.baseElement.textContent ?? "";
		expect(text).toContain("Mortgage");
		expect(text).toContain("First chat");
		expect(text).toContain("Second chat");
		expect(text).not.toMatch(/Loading/i);
		await settle();
		expect(fetched).toEqual([]);
	});

	it("returning when stale shows the cache at once, then folds the change in place", async () => {
		const first = mount();
		await expect.element(first.getByText("First chat")).toBeVisible();
		first.unmount();
		fetched.length = 0;
		projectsTreeCache.fetchedAt = Date.now() - PROJECTS_CACHE_STALE_MS - 1;
		for (const id of Object.keys(projectsTreeCache.chatsFetchedAt))
			projectsTreeCache.chatsFetchedAt[id] = 1;
		const cachedProject = projectsTreeCache.projects[0];
		const cachedC1 = projectsTreeCache.chats.p1[0];
		chats = [chat("c1", "First chat"), chat("c2", "Second renamed")];

		const second = mount();
		flushSync();
		expect(second.baseElement.textContent).toContain("Second chat");
		expect(second.baseElement.textContent).not.toMatch(/Loading/i);
		const c1Row = second.getByText("First chat").element();

		await expect.element(second.getByText("Second renamed")).toBeVisible();
		expect(fetched.filter((u) => u.endsWith("/api/v2/projects"))).toHaveLength(1);
		expect(second.getByText("First chat").element()).toBe(c1Row);
		expect(projectsTreeCache.projects[0]).toBe(cachedProject);
		expect(projectsTreeCache.chats.p1[0]).toBe(cachedC1);
	});

	it("a failed refresh keeps the cached rows", async () => {
		const first = mount();
		await expect.element(first.getByText("First chat")).toBeVisible();
		first.unmount();
		projectsTreeCache.fetchedAt = 1;
		for (const id of Object.keys(projectsTreeCache.chatsFetchedAt))
			projectsTreeCache.chatsFetchedAt[id] = 1;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("no", { status: 500 }))
		);

		const second = mount();
		await settle();
		expect(second.baseElement.textContent).toContain("Mortgage");
		expect(second.baseElement.textContent).toContain("First chat");
		expect(second.baseElement.textContent).not.toMatch(/unavailable/i);
	});
});

describe("the projects cache belongs to one user", () => {
	it("signing out drops it", async () => {
		const screen = mount();
		await expect.element(screen.getByText("First chat")).toBeVisible();
		screen.unmount();
		expect(projectsTreeCache.projects).toHaveLength(1);

		const footer = renderWithApp(NavFooter, { user: { username: "ada" } } as never);
		footer.baseElement
			.querySelector("form")
			?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		expect(projectsTreeCache.projects).toEqual([]);
		expect(projectsTreeCache.chats).toEqual({});
		expect(projectsTreeCache.loaded).toBe(false);
		footer.unmount();
	});

	it("a different account never sees the previous one's projects", async () => {
		const first = renderWithApp(
			ProjectsBranch,
			{},
			{ page: { params: {}, data: { models: [], user: { id: "ada" } } }, ...context() }
		);
		await expect.element(first.getByText("First chat")).toBeVisible();
		first.unmount();
		projects = [mkProject("p9", "Other")];
		chats = [chat("c9", "Other chat")];
		const second = renderWithApp(
			ProjectsBranch,
			{},
			{ page: { params: {}, data: { models: [], user: { id: "bob" } } }, ...context() }
		);
		expect(second.baseElement.textContent).not.toContain("Mortgage");
		await expect.element(second.getByText("Other")).toBeVisible();
	});
});
