import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import NavMenu from "../NavMenu.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { codeNav } from "$lib/stores/codeNav.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { codeTreeCache, clearCodePanelCache } from "$lib/stores/codeTreeCache.svelte";
import { codeReauth, resetCodeReauth } from "$lib/stores/codeReauth.svelte";
import { projectsTreeCache } from "$lib/stores/projectsTreeCache.svelte";
import { ACTIVE_GENERATIONS_CONTEXT_KEY } from "$lib/stores/activeGenerations.svelte";
import superjson from "superjson";
import type { ConvSidebar } from "$lib/types/ConvSidebar";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const listDevices = vi.hoisted(() => vi.fn());
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listDevices,
	listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
	listAgents: vi.fn(async () => ({ agents: [] })),
	loadCodeStatus: vi.fn(async () => undefined),
}));

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const conv = (id: string, hours: number, extra: Partial<ConvSidebar> = {}): ConvSidebar => ({
	id,
	title: `Chat ${id}`,
	updatedAt: ago(hours),
	lastActivityAt: ago(hours),
	...extra,
});

describe("NavMenu's Recent selector", () => {
	let host: HTMLElement;

	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes("/api/v2/projects")
					? Response.json({ data: [] })
					: Response.json({ conversations: [] })
			)
		);
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
		codeNav.view = "recent";
		resetCodeReauth();
		clearCodePanelCache();
		projectsTreeCache.projects = [];
		projectsTreeCache.loaded = false;
	});

	// Every mounted sidebar is destroyed before the stubs go: a live one keeps
	// its polls and scroll timers running, and they would reach the real network.
	const mounted: { unmount: () => void }[] = [];
	afterEach(() => {
		for (const screen of mounted.splice(0)) screen.unmount();
		vi.unstubAllGlobals();
		codeNav.view = "auto";
		host.remove();
	});

	function mount(
		conversations: ConvSidebar[],
		opts: { agents?: boolean; data?: Record<string, unknown> } = {}
	) {
		const screen = renderWithApp(
			NavMenu,
			{
				conversations,
				user: { username: "ada" },
				gatewayIsAdmin: false,
				codeAgentsEnabled: opts.agents ?? false,
			} as never,
			{
				page: { route: { id: "/" }, data: { models: [], ...opts.data } },
				baseElement: host,
				// If the view flips back to Chats, a conversation row asks for its live-turn badge.
				context: new Map<unknown, unknown>([
					[ACTIVE_GENERATIONS_CONTEXT_KEY, { has: () => false }],
				]),
			}
		);
		mounted.push(screen);
		return screen;
	}

	it("offers Chats, Recent and (with agents) Agents, with Recent pressed", () => {
		mount([], { agents: true });
		for (const id of ["chats", "recent", "agents"]) {
			expect(host.querySelector(`[data-testid="sidebar-view-${id}"]`)).not.toBeNull();
		}
		const recent = host.querySelector('[data-testid="sidebar-view-recent"]') as HTMLElement;
		expect(recent.getAttribute("aria-label")).toBe("Recent");
		expect(recent.getAttribute("aria-pressed")).toBe("true");
		expect(host.querySelector('[data-testid="recent-list"]')).not.toBeNull();
		expect(
			host.querySelector('[data-testid="chats-header"], [data-testid="projects-header"]')
		).toBeNull();
	});

	it("is offered without agents, listing chats only", () => {
		mount([conv("a", 1)]);
		expect(host.querySelector('[data-testid="sidebar-view-agents"]')).toBeNull();
		expect(host.querySelector('[data-testid="sidebar-view-recent"]')).not.toBeNull();
		const rows = host.querySelectorAll('[data-testid="recent-row"]');
		expect(rows).toHaveLength(1);
		expect(rows[0].getAttribute("data-kind")).toBe("chat");
	});

	it("keeps the Chats-mode controls around the list: New chat and Schedules, aimed at chats", () => {
		mount([], { data: { chatSchedulesEnabled: true, codeSchedulesEnabled: true } });
		const newChat = host.querySelector('[data-testid="new-chat"]') as HTMLAnchorElement;
		expect(newChat.getAttribute("href")).toBe("/");
		expect(newChat.textContent?.trim()).toBe("New chat");
		expect(host.querySelector('[data-testid="new-agent-session"]')).toBeNull();
		expect(host.querySelector('[data-testid="schedules-link"]')?.getAttribute("href")).toBe(
			"/schedules?kind=chat"
		);
		expect(host.querySelector('[data-testid="workspace-link"]')).not.toBeNull();
	});

	it("shows an empty state", () => {
		mount([]);
		expect(host.querySelector('[data-testid="recent-empty"]')?.textContent).toContain(
			"Nothing recent yet"
		);
	});

	it("shows a project badge on a project chat and links to the chat", async () => {
		projectsTreeCache.projects = [{ id: "p1", name: "Thesis" } as never];
		projectsTreeCache.loaded = true;
		mount([conv("c1", 1, { projectId: "p1" }), conv("c2", 2)]);
		const rows = [...host.querySelectorAll('[data-testid="recent-row"]')];
		expect(rows.map((r) => r.getAttribute("href"))).toEqual([
			"/conversation/c1",
			"/conversation/c2",
		]);
		expect(rows[0].querySelector('[data-testid="recent-project"]')?.textContent).toContain(
			"Thesis"
		);
		expect(rows[1].querySelector('[data-testid="recent-project"]')).toBeNull();
		expect(rows[0].querySelector("time")?.textContent).toMatch(/hour/);
	});

	it("lists agent sessions with the machine name, an online dot and a link into the agent view", async () => {
		listDevices.mockResolvedValue({
			devices: [
				{ id: "d1", name: "laptop", status: "paired", online: true, backends: [], policy: {} },
				{ id: "d2", name: "desk", status: "paired", online: false, backends: [], policy: {} },
			],
		});
		codeReauth.checked = true;
		codeReauth.required = false;
		codeDeviceList.devices = [
			{ id: "d1", name: "laptop", status: "paired", online: true },
			{ id: "d2", name: "desk", status: "paired", online: false },
		] as never;
		codeDeviceList.fetchedAt = Date.now();
		codeTreeCache.trees = {
			d1: {
				off: false,
				workspaces: [],
				agents: [
					{
						id: "s1",
						workspaceId: "w1",
						title: "Fix the build",
						state: "idle",
						updatedAt: ago(0.5).toISOString(),
						parentId: null,
					},
				],
			},
			d2: {
				off: false,
				workspaces: [],
				agents: [
					{
						id: "s2",
						workspaceId: "w2",
						title: "Old refactor",
						state: "idle",
						updatedAt: ago(3).toISOString(),
						parentId: null,
					},
				],
			},
		} as never;
		codeTreeCache.fetchedAt = { d1: Date.now(), d2: Date.now() };
		mount([conv("c1", 1)], { agents: true });
		const rows = [...host.querySelectorAll('[data-testid="recent-row"]')];
		await vi.waitFor(() =>
			expect(host.querySelectorAll('[data-testid="recent-row"][data-kind="agent"]')).toHaveLength(2)
		);
		const all = [...host.querySelectorAll('[data-testid="recent-row"]')];
		expect(all.map((r) => r.getAttribute("data-kind"))).toEqual(["agent", "chat", "agent"]);
		expect(all[0].getAttribute("href")).toBe("/code?device=d1&ws=w1&agent=s1");
		expect(all[0].querySelector('[data-testid="recent-machine"]')?.textContent).toContain("laptop");
		expect(
			all[0].querySelector('[data-testid="recent-machine-dot"]')?.getAttribute("data-status")
		).toBe("online");
		expect(
			all[2].querySelector('[data-testid="recent-machine-dot"]')?.getAttribute("data-status")
		).toBe("offline");
		void rows;
	});

	it("moves a chat to the top when its activity is newer", async () => {
		const screen = mount([conv("a", 1), conv("b", 2)]);
		const order = () =>
			[...host.querySelectorAll('[data-testid="recent-row"]')].map((r) => r.getAttribute("href"));
		expect(order()).toEqual(["/conversation/a", "/conversation/b"]);
		await screen.rerender({ conversations: [conv("a", 1), conv("b", 0)] } as never);
		await vi.waitFor(() => expect(order()).toEqual(["/conversation/b", "/conversation/a"]));
	});

	it("fits a phone-width drawer without a horizontal scroll", async () => {
		host.style.width = "330px";
		mount(
			[conv("c1", 1, { title: "A very long chat title that must truncate rather than overflow" })],
			{
				agents: true,
			}
		);
		const list = host.querySelector('[data-testid="recent-list"]') as HTMLElement;
		expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth + 1);
	});

	it("does not page through the whole history when the loaded chats are already outside the window", async () => {
		let pages = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/api/v2/projects")) return Response.json({ data: [] });
				pages += 1;
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 40));
				inFlight -= 1;
				const page = Number(new URL(url, "http://x").searchParams.get("p") ?? 0);
				// Endless, and always old: every page claims there is another.
				return new Response(
					superjson.stringify({
						conversations: Array.from({ length: 30 }, (_, i) => ({
							id: `old-${page}-${i}`,
							title: `Old ${page}-${i}`,
							updatedAt: ago(500 + page).toISOString(),
							lastActivityAt: ago(500 + page).toISOString(),
						})),
						hasMore: true,
					})
				);
			})
		);
		mount([conv("a", 100), conv("b", 101)]);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		// One page fills the list past ten rows; nothing after that.
		expect(pages).toBeLessThanOrEqual(1);
		expect(maxInFlight).toBeLessThanOrEqual(1);
		expect(host.querySelectorAll('[data-testid="recent-row"]').length).toBeGreaterThanOrEqual(10);
	});

	it("stops paging when the server says there is no more", async () => {
		let pages = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes("/api/v2/projects")) return Response.json({ data: [] });
				pages += 1;
				return new Response(
					superjson.stringify({
						conversations: [{ id: "x", title: "X", updatedAt: ago(1) }],
						hasMore: false,
					})
				);
			})
		);
		mount([conv("a", 1)]);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(pages).toBe(1);
	});

	it("marks every switch button with aria-pressed, and hides row icons from screen readers", () => {
		mount([conv("a", 1)], { agents: true });
		const pressed = ["chats", "recent", "agents"].map((id) =>
			host.querySelector(`[data-testid="sidebar-view-${id}"]`)?.getAttribute("aria-pressed")
		);
		expect(pressed).toEqual(["false", "true", "false"]);
		const row = host.querySelector('[data-testid="recent-row"]') as HTMLElement;
		expect(row.querySelector("svg")?.getAttribute("aria-label")).toBeNull();
		expect(row.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
		expect(row.querySelector(".sr-only")?.textContent).toBe("Chat");
	});

	it("shows the unread dot on a chat a scheduled run answered", () => {
		mount([conv("a", 1, { unread: true }), conv("b", 2)]);
		const rows = host.querySelectorAll('[data-testid="recent-row"]');
		expect(rows[0].querySelector('[data-testid="unread-dot"]')).not.toBeNull();
		expect(rows[1].querySelector('[data-testid="unread-dot"]')).toBeNull();
	});

	function seedMachines(
		devices: Record<string, unknown>[],
		trees: Record<string, Record<string, unknown>[]>
	) {
		codeReauth.checked = true;
		codeReauth.required = false;
		codeDeviceList.devices = devices as never;
		codeDeviceList.fetchedAt = Date.now();
		codeTreeCache.trees = Object.fromEntries(
			Object.entries(trees).map(([id, agents]) => [id, { off: false, workspaces: [], agents }])
		) as never;
		codeTreeCache.fetchedAt = Object.fromEntries(Object.keys(trees).map((id) => [id, Date.now()]));
	}
	const session = (id: string, hours: number, extra: Record<string, unknown> = {}) => ({
		id,
		workspaceId: "w",
		title: `S ${id}`,
		state: "idle",
		updatedAt: ago(hours).toISOString(),
		parentId: null,
		...extra,
	});

	it("keys agent rows by machine, so the same session id on two machines is two rows", async () => {
		seedMachines(
			[
				{ id: "d1", name: "one", status: "paired", online: true },
				{ id: "d2", name: "two", status: "paired", online: true },
			],
			{ d1: [session("same", 1)], d2: [session("same", 2)] }
		);
		mount([], { agents: true });
		await vi.waitFor(() =>
			expect(host.querySelectorAll('[data-testid="recent-row"][data-kind="agent"]')).toHaveLength(2)
		);
	});

	it("marks a running session and one that needs the user", async () => {
		seedMachines([{ id: "d1", name: "one", status: "paired", online: true }], {
			d1: [session("r", 1, { state: "running" }), session("w", 2, { state: "waiting-permission" })],
		});
		mount([], { agents: true });
		await vi.waitFor(() =>
			expect(host.querySelector('[data-testid="recent-running"]')).not.toBeNull()
		);
		expect(host.querySelector('[data-testid="recent-needs-you"]')?.textContent).toContain(
			"Needs you"
		);
	});

	it("leaves out the sessions of a machine that must be enrolled again", async () => {
		seedMachines(
			[
				{ id: "d1", name: "one", status: "paired", online: true },
				{ id: "d2", name: "gone", status: "paired", online: true, reenroll: "revoked" },
			],
			{ d1: [session("a", 1)], d2: [session("b", 1)] }
		);
		mount([], { agents: true });
		await vi.waitFor(() =>
			expect(host.querySelectorAll('[data-testid="recent-row"][data-kind="agent"]')).toHaveLength(1)
		);
	});

	it("says to sign in again, instead of silently dropping sessions, while the sign-in is stale", async () => {
		seedMachines([{ id: "d1", name: "one", status: "paired", online: true }], {
			d1: [session("a", 1)],
		});
		mount([conv("c", 1)], { agents: true });
		await vi.waitFor(() =>
			expect(host.querySelectorAll('[data-testid="recent-row"][data-kind="agent"]')).toHaveLength(1)
		);
		codeReauth.required = true;
		await vi.waitFor(() =>
			expect(host.querySelector('[data-testid="recent-reauth"]')?.textContent).toContain(
				"Sign in again to see agent sessions"
			)
		);
		expect(host.querySelectorAll('[data-testid="recent-row"][data-kind="agent"]')).toHaveLength(0);
		expect(host.querySelectorAll('[data-testid="recent-row"][data-kind="chat"]')).toHaveLength(1);
	});

	it("highlights a session by ?agent= only on /code", async () => {
		seedMachines([{ id: "d1", name: "one", status: "paired", online: true }], {
			d1: [session("a", 1)],
		});
		const screen = renderWithApp(
			NavMenu,
			{
				conversations: [],
				user: { username: "ada" },
				gatewayIsAdmin: false,
				codeAgentsEnabled: true,
			} as never,
			{
				page: {
					route: { id: "/schedules" },
					url: new URL("http://localhost/schedules?agent=a"),
					data: { models: [] },
				},
				baseElement: host,
				context: new Map<unknown, unknown>([
					[ACTIVE_GENERATIONS_CONTEXT_KEY, { has: () => false }],
				]),
			}
		);
		mounted.push(screen);
		await vi.waitFor(() =>
			expect(host.querySelector('[data-testid="recent-row"][data-kind="agent"]')).not.toBeNull()
		);
		expect(
			host.querySelector('[data-testid="recent-row"][data-kind="agent"]')?.className
		).not.toContain("font-medium");
	});

	it("reads the project list again when a chat names a project it does not know", async () => {
		let projectReads = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes("/api/v2/projects")) {
					projectReads += 1;
					return Response.json({ data: [{ id: "p2", name: "Later" }] });
				}
				return Response.json({ conversations: [], hasMore: false });
			})
		);
		const screen = mount([conv("a", 1)]);
		expect(projectReads).toBe(0);
		await screen.rerender({
			conversations: [conv("a", 1), conv("b", 2, { projectId: "p2" })],
		} as never);
		await vi.waitFor(() =>
			expect(host.querySelector('[data-testid="recent-project"]')?.textContent).toContain("Later")
		);
		expect(projectReads).toBe(1);
	});
});
