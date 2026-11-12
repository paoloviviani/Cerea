import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import NavMenu from "../NavMenu.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { codeNav } from "$lib/stores/codeNav.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { codeTreeCache, clearCodePanelCache } from "$lib/stores/codeTreeCache.svelte";
import { codeReauth, resetCodeReauth } from "$lib/stores/codeReauth.svelte";
import { projectsTreeCache } from "$lib/stores/projectsTreeCache.svelte";
import { ACTIVE_GENERATIONS_CONTEXT_KEY } from "$lib/stores/activeGenerations.svelte";
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

void ACTIVE_GENERATIONS_CONTEXT_KEY;

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

	afterEach(() => {
		vi.unstubAllGlobals();
		codeNav.view = "auto";
		host.remove();
	});

	function mount(
		conversations: ConvSidebar[],
		opts: { agents?: boolean; data?: Record<string, unknown> } = {}
	) {
		return renderWithApp(
			NavMenu,
			{
				conversations,
				user: { username: "ada" },
				gatewayIsAdmin: false,
				codeAgentsEnabled: opts.agents ?? false,
			} as never,
			{ page: { route: { id: "/" }, data: { models: [], ...opts.data } }, baseElement: host }
		);
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
});
