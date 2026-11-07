import NavMenu from "./NavMenu.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import superjson from "superjson";
import {
	codeReauth,
	resetCodeReauth,
	flagCodeReauth,
	signOutRedirect,
} from "$lib/stores/codeReauth.svelte";
import { clearCodeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { codeNav } from "$lib/stores/codeNav.svelte";
import { codeNeedsYou, publishPending, clearPending } from "$lib/stores/codeNeedsYou.svelte";
import { ACTIVE_GENERATIONS_CONTEXT_KEY } from "$lib/stores/activeGenerations.svelte";

// NavMenu mounts the sidebar tree, whose project rows read the
// connector stores: those read a deployment name off the environment at
// module scope, and the bare name is all a test needs (same mock as the
// ConnectorsSection suite).
vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const listDevices = vi.hoisted(() => vi.fn());
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listDevices,
}));

/**
 * The sidebar's foot, after the managers moved into the workspace and the
 * profile menu became a static footer: Workspace, Settings and (for
 * administrators) Admin are rows; the footer names the person and carries the
 * theme switch and the sign-out form inline. Models, Knowledge and MCP Servers
 * are no longer rows here at all.
 */
describe("NavMenu's foot", () => {
	let host: HTMLElement;

	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ conversations: [] }))
		);
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		host.remove();
	});

	function mount(
		user: object | null,
		gatewayIsAdmin = false,
		data: Record<string, unknown> = {},
		url?: URL
	) {
		return renderWithApp(NavMenu, { conversations: [], user, gatewayIsAdmin } as never, {
			page: { data: { models: [], ...data }, ...(url ? { url } : {}) },
			baseElement: host,
		});
	}

	it("has one Schedules row in the foot group, above Workspace, when scheduled actions are on, and not otherwise", () => {
		mount({ username: "ada" }, false, { chatSchedulesEnabled: true });
		const row = host.querySelector('[data-testid="schedules-link"]');
		expect(row?.getAttribute("href")).toBe("/schedules");
		// Not at the top of the tree any more: after Projects and Chats, before Workspace.
		const links = [...host.querySelectorAll("a")];
		const rowIndex = links.findIndex((a) => a === row);
		const chats = links.findIndex((a) => a.getAttribute("href") === "/chats");
		const workspace = links.findIndex((a) => a.getAttribute("href") === "/workspace");
		expect(rowIndex).toBeGreaterThan(chats);
		expect(rowIndex).toBeLessThan(workspace);
		expect(host.querySelectorAll('a[href^="/schedules"]')).toHaveLength(1);
		host.innerHTML = "";
		mount({ username: "ada" }, false, { chatSchedulesEnabled: false });
		expect(host.querySelector('[data-testid="schedules-link"]')).toBeNull();
		host.innerHTML = "";
		mount(null, false, { chatSchedulesEnabled: true });
		expect(host.querySelector('[data-testid="schedules-link"]')).toBeNull();
		host.innerHTML = "";
		// Agent schedules alone are enough to show the row.
		mount({ username: "ada" }, false, { codeSchedulesEnabled: true });
		expect(host.querySelector('[data-testid="schedules-link"]')).not.toBeNull();
	});

	it("opens the Schedules page filtered to Chats from the chats list when both kinds exist", () => {
		mount({ username: "ada" }, false, { chatSchedulesEnabled: true, codeSchedulesEnabled: true });
		expect(host.querySelector('[data-testid="schedules-link"]')?.getAttribute("href")).toBe(
			"/schedules?kind=chat"
		);
	});

	it("marks the Schedules row active on the schedules page", () => {
		mount(
			{ username: "ada" },
			false,
			{ chatSchedulesEnabled: true },
			new URL("http://localhost/schedules")
		);
		const active = host.querySelector('[data-testid="schedules-link"]');
		expect(active?.className).toContain("font-semibold");
		expect(active?.className).not.toContain("hover:bg-gray-100");
	});

	it("draws the attention badge on the Schedules row only when a run needs attention", async () => {
		const { scheduleAttention } = await import("$lib/stores/scheduleAttention.svelte");
		scheduleAttention.count = 0;
		mount({ username: "ada" }, false, { chatSchedulesEnabled: true });
		expect(host.querySelector('[data-testid="schedules-attention"]')).toBeNull();
		scheduleAttention.count = 2;
		await vi.waitFor(() =>
			expect(host.querySelector('[data-testid="schedules-attention"]')?.textContent).toBe("2")
		);
		expect(host.querySelector('[data-testid="schedules-link"]')?.getAttribute("aria-label")).toBe(
			"Schedules, 2 need attention"
		);
		scheduleAttention.count = 0;
	});

	it("the foot has Schedules and Workspace rows with icons, and Settings and Admin only in the user menu", async () => {
		const screen = mount({ username: "ada" }, true, { chatSchedulesEnabled: true });

		const workspace = host.querySelector('a[href="/workspace"]');
		expect(workspace?.querySelector("svg")).not.toBeNull();
		expect(host.querySelector('[data-testid="schedules-link"] svg')).not.toBeNull();
		// Same shape: one class string for both rows (the active variant aside).
		expect(workspace?.className).toBe(
			host.querySelector('[data-testid="schedules-link"]')?.className
		);
		// No manager rows, and Settings/Admin are not rows any more.
		const text = (host.textContent ?? "").replace(/\s+/g, " ");
		expect(text).not.toContain("Knowledge");
		expect(text).not.toContain("MCP Servers");
		expect(host.querySelector('a[href="/settings/application"]')).toBeNull();
		expect(host.querySelector('a[href="/admin"]')).toBeNull();
		await screen.getByTestId("user-menu-button").click();
		await vi.waitFor(() =>
			expect(
				host.querySelector('[data-testid="user-menu"] a[href="/settings/application"]')
			).not.toBeNull()
		);
		expect(host.querySelector('[data-testid="user-menu"] a[href="/admin"]')).not.toBeNull();
	});

	it("keeps the old icon row out: no inline theme, reload or sign-out buttons outside the menu", () => {
		mount({ username: "ada" });
		expect(host.querySelector("form")).toBeNull();
		expect(host.querySelector('button[title="Reload"]')).toBeNull();
	});

	it("the signed-out panel keeps Workspace and a plain Settings row, and no user menu", () => {
		mount(null);

		expect(host.querySelector('a[href="/workspace"]')).not.toBeNull();
		expect(host.querySelector('a[href="/settings/application"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="user-menu-button"]')).toBeNull();
		expect(host.querySelector("form")).toBeNull();
	});

	it("shows the app name as a wordmark beside the ridge, hidden from screen readers", () => {
		mount({ username: "ada" });
		const word = host.querySelector('[data-testid="sidebar-wordmark"]') as HTMLElement;
		expect(word.textContent?.trim()).toBe("chat-ui");
		expect(word.getAttribute("aria-hidden")).toBe("true");
	});

	it("puts New chat under the logo, in the top block, as a link to the start page", () => {
		mount({ username: "ada" });
		const link = host.querySelector('[data-testid="new-chat"]') as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("/");
		expect(link.textContent?.trim()).toBe("New chat");
		const links = [...host.querySelectorAll("a")];
		expect(links.indexOf(link)).toBeLessThan(
			links.findIndex((a) => a.getAttribute("href") === "/projects")
		);
	});
});

/**
 * Projects and Chats are pages as well as folders: the label opens the page
 * (the list of projects, the searchable list of chats) and only the chevron
 * expands or collapses the branch.
 */
describe("NavMenu's Chats header", () => {
	let host: HTMLElement;

	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ conversations: [] }))
		);
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		host.remove();
	});

	const chat = {
		id: "c1",
		title: "Plan the offsite",
		updatedAt: new Date(),
		model: "m",
	};

	function mount() {
		return renderWithApp(
			NavMenu,
			{ conversations: [chat], user: { username: "ada" }, gatewayIsAdmin: false } as never,
			{
				page: { data: { models: [] } },
				baseElement: host,
				// A conversation row asks this store for its live-turn badge.
				context: new Map<unknown, unknown>([
					[ACTIVE_GENERATIONS_CONTEXT_KEY, { has: () => false }],
				]),
			}
		);
	}

	it("the label links to /chats and following it leaves the branch open", () => {
		mount();

		const link = host.querySelector('a[href="/chats"]') as HTMLAnchorElement;
		expect(link.textContent?.trim()).toBe("Chats");
		let followed = false;
		link.addEventListener("click", (event) => {
			followed = !event.defaultPrevented;
			event.preventDefault();
		});
		link.click();

		expect(followed).toBe(true);
		expect(host.textContent).toContain("Plan the offsite");
		expect(host.querySelector('button[aria-label="Collapse Chats"]')).not.toBeNull();
	});

	it("the chevron alone collapses and expands the list", async () => {
		mount();
		expect(host.textContent).toContain("Plan the offsite");

		(host.querySelector('button[aria-label="Collapse Chats"]') as HTMLElement).click();
		await vi.waitFor(() => expect(host.textContent).not.toContain("Plan the offsite"));
		const expand = host.querySelector('button[aria-label="Expand Chats"]') as HTMLElement;
		expect(expand.getAttribute("aria-expanded")).toBe("false");

		expand.click();
		await vi.waitFor(() => expect(host.textContent).toContain("Plan the offsite"));
		expect(host.querySelector('button[aria-label="Collapse Chats"]')).not.toBeNull();
	});

	it("both headers are links with a chevron of their own, each a link and a button of its own", () => {
		mount();

		expect(host.querySelector('a[href="/projects"]')).not.toBeNull();
		expect(host.querySelector('button[aria-label="Expand Projects"]')).not.toBeNull();
		expect(host.querySelector('a[href="/chats"]')).not.toBeNull();
		expect(host.querySelector('button[aria-label="Collapse Chats"]')).not.toBeNull();
	});
});

/**
 * The agents side of the sidebar while the /code sign-in is stale: the
 * Chats | Agents switch stays, and the machine tree does not exist — nothing
 * is asked of a machine, so nothing it said can be drawn.
 */
describe("NavMenu's agents list and the /code sign-in", () => {
	let host: HTMLElement;
	let screen: { unmount(): unknown } | undefined;

	function stubFetch(status: Record<string, unknown>) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes("/api/v2/code/status")
					? new Response(superjson.stringify(status), { status: 200 })
					: Response.json({ conversations: [] })
			)
		);
	}

	function mount(routeId = "/code") {
		screen = renderWithApp(
			NavMenu,
			{
				conversations: [],
				user: { username: "ada" },
				gatewayIsAdmin: false,
				codeAgentsEnabled: true,
			} as never,
			{ page: { route: { id: routeId }, data: { models: [] } }, baseElement: host }
		);
		return screen;
	}

	/** A chat page with the Agents tab picked: where the sidebar is the only
	 * place that can say the sign-in is stale. */
	function mountAgentsTabOnAChat() {
		codeNav.view = "agents";
		return mount("/");
	}

	beforeEach(() => {
		resetCodeReauth();
		// The device list is a module-level store that skips a re-read while fresh.
		clearCodeDeviceList();
		codeNav.view = "auto";
		listDevices.mockReset();
		listDevices.mockResolvedValue({ devices: [] });
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	});

	afterEach(() => {
		// Unmount first: the sidebar's effect reads `codeReauth.checked`, so a
		// component left mounted re-asks /status the moment the store is reset
		// below, with the stub already gone (a real request to the dev server,
		// whose answer the next test then shares through `statusInflight`).
		screen?.unmount();
		screen = undefined;
		vi.unstubAllGlobals();
		resetCodeReauth();
		host.remove();
	});

	it("says the sign-in is stale in the Agents view, with the reauth link", async () => {
		stubFetch({ enabled: true, fresh: false, reauthPath: "/login?reauth=1&next=/code" });
		mountAgentsTabOnAChat();
		await vi.waitFor(() =>
			expect(host.querySelector('[data-testid="code-reauth-card"]')).not.toBeNull()
		);
		const card = host.querySelector('[data-testid="code-reauth-card"]');
		expect(card?.getAttribute("data-variant")).toBe("stale");
		expect(card?.querySelector("a")?.getAttribute("href")).toBe("/login?reauth=1&next=/code");
		expect(host.querySelector('[data-testid="device-rail"]')).toBeNull();
	});

	it("offers the plain sign-in in the Agents view when there is no session", async () => {
		stubFetch({
			enabled: true,
			fresh: false,
			signedIn: false,
			reauthPath: "/login?reauth=1&next=/code",
			signInPath: "/login?next=/code",
		});
		// Keep the test page where it is: the status answer would redirect it.
		const go = vi.spyOn(signOutRedirect, "go").mockImplementation(() => {});
		try {
			mountAgentsTabOnAChat();
			await vi.waitFor(() =>
				expect(host.querySelector('[data-testid="code-reauth-card"]')).not.toBeNull()
			);
			const card = host.querySelector('[data-testid="code-reauth-card"]');
			expect(card?.getAttribute("data-variant")).toBe("signed-out");
			expect(card?.querySelector("a")?.getAttribute("href")).toBe("/login?next=/code");
		} finally {
			go.mockRestore();
		}
	});

	it("leaves the prompt to the panel on /code, so there is one card, not two", async () => {
		stubFetch({ enabled: true, fresh: false, reauthPath: "/login?reauth=1&next=/code" });
		mount("/code");
		await vi.waitFor(() => expect(codeReauth.required).toBe(true));
		expect(host.querySelector('[data-testid="code-reauth-card"]')).toBeNull();
		expect(host.querySelector('[data-testid="device-rail"]')).toBeNull();
	});

	it("shows no prompt, only the tree, when the sign-in is fresh", async () => {
		stubFetch({
			enabled: true,
			fresh: true,
			reauthPath: "/login?reauth=1&next=/code",
			freshUntil: new Date(Date.now() + 3_600_000).toISOString(),
		});
		mount();
		await vi.waitFor(() => expect(host.textContent).toContain("Pair a computer"));
		expect(host.querySelector('[data-testid="code-reauth-card"]')).toBeNull();
	});

	it("keeps only the Chats | Agents switch, and asks no machine, while stale", async () => {
		stubFetch({ enabled: true, fresh: false, reauthPath: "/login?reauth=1&next=/code" });
		mount();
		await vi.waitFor(() =>
			expect(host.querySelector('[data-testid="sidebar-view-agents"]')).not.toBeNull()
		);
		// Wait for the answer itself: before it, an absent tree proves nothing.
		await vi.waitFor(() => expect(codeReauth.required).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(host.querySelector('[data-testid="sidebar-view-chats"]')).not.toBeNull();
		expect(listDevices).not.toHaveBeenCalled();
		// No tree: the tree's own markers and its pairing control are absent.
		expect(host.querySelector('[data-testid="device-rail"]')).toBeNull();
		expect((host.textContent ?? "").replace(/\s+/g, " ")).not.toContain("Pair a computer");
	});

	it("puts the switch under the logo and above the list, and New session follows it in Agents mode", async () => {
		stubFetch({
			enabled: true,
			fresh: true,
			reauthPath: "/login?reauth=1&next=/code",
			freshUntil: new Date(Date.now() + 3_600_000).toISOString(),
		});
		codeNav.view = "chats";
		mount("/");
		const sw = () => host.querySelector('[data-testid="sidebar-view-chats"]') as HTMLElement;
		await vi.waitFor(() => expect(sw()).not.toBeNull());
		// Chats mode: New chat, and the switch is above the Projects tree.
		expect(host.querySelector('[data-testid="new-chat"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="new-agent-session"]')).toBeNull();
		const all = [...host.querySelectorAll("*")];
		const projects = host.querySelector('a[href="/projects"]') as Element;
		expect(all.indexOf(sw())).toBeLessThan(all.indexOf(projects));
		// Agents mode: the button follows the switch.
		(host.querySelector('[data-testid="sidebar-view-agents"]') as HTMLElement).click();
		await vi.waitFor(() =>
			expect(host.querySelector('[data-testid="new-agent-session"]')).not.toBeNull()
		);
		expect(host.querySelector('[data-testid="new-chat"]')).toBeNull();
		expect(host.querySelector('[data-testid="new-agent-session"]')?.textContent?.trim()).toBe(
			"New session"
		);
		// No machine is paired: the button opens the Pair dialog, not the chooser.
		(host.querySelector('[data-testid="new-agent-session"]') as HTMLElement).click();
		await vi.waitFor(() => expect(document.body.textContent).toContain("Pair"));
		expect(document.querySelector('[data-testid="new-agent-machine"]')).toBeNull();
	});

	it("badges the Agents option with the asks waiting, and names the count for a screen reader", async () => {
		stubFetch({
			enabled: true,
			fresh: true,
			reauthPath: "/login?reauth=1&next=/code",
			freshUntil: new Date(Date.now() + 3_600_000).toISOString(),
		});
		mount("/");
		const agents = () => host.querySelector('[data-testid="sidebar-view-agents"]');
		await vi.waitFor(() => expect(agents()).not.toBeNull());
		expect(host.querySelector('[data-testid="sidebar-agents-badge"]')).toBeNull();
		expect(agents()?.getAttribute("aria-label")).toBeNull();
		publishPending([
			{ deviceId: "d1", sessionId: "a1" },
			{ deviceId: "d1", sessionId: "a2" },
		]);
		await vi.waitFor(() =>
			expect(host.querySelector('[data-testid="sidebar-agents-badge"]')?.textContent).toBe("2")
		);
		expect(agents()?.getAttribute("aria-label")).toBe("Agents, 2 need you");
		publishPending([{ deviceId: "d1", sessionId: "a1" }]);
		await vi.waitFor(() =>
			expect(agents()?.getAttribute("aria-label")).toBe("Agents, 1 needs you")
		);
		clearPending();
		await vi.waitFor(() =>
			expect(host.querySelector('[data-testid="sidebar-agents-badge"]')).toBeNull()
		);
		expect(codeNeedsYou.pending).toHaveLength(0);
	});

	it("draws the tree once the sign-in is known to be fresh, and drops it when a call finds it stale", async () => {
		stubFetch({
			enabled: true,
			fresh: true,
			reauthPath: "/login?reauth=1&next=/code",
			freshUntil: new Date(Date.now() + 3_600_000).toISOString(),
		});
		mount();
		await vi.waitFor(() => expect(listDevices).toHaveBeenCalled());
		await vi.waitFor(() => expect(host.textContent).toContain("Pair a computer"));
		const calls = listDevices.mock.calls.length;
		flagCodeReauth();
		await vi.waitFor(() => expect(host.textContent).not.toContain("Pair a computer"));
		expect(host.querySelector('[data-testid="sidebar-view-agents"]')).not.toBeNull();
		expect(listDevices.mock.calls.length).toBe(calls);
	});

	it("renders no Chats | Agents switch, and asks /status for nobody, when the person is denied", () => {
		// ADR 0096: the switch is per-person. `codeAgentsEnabled` reaches this
		// component already decided (the layout's awaited /v1/me answer, and
		// feature-flags' own per-person answer) — with it false nothing of the
		// panel exists: no switch, no tree, no /status request.
		const fetchSpy = vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes("/api/v2/code/status")
				? new Response(superjson.stringify({ enabled: true, fresh: true }), { status: 200 })
				: Response.json({ conversations: [] })
		);
		vi.stubGlobal("fetch", fetchSpy);
		renderWithApp(
			NavMenu,
			{
				conversations: [],
				user: { username: "ada" },
				gatewayIsAdmin: false,
				codeAgentsEnabled: false,
			} as never,
			{ page: { route: { id: "/" }, data: { models: [] } }, baseElement: host }
		);

		expect(host.querySelector('[data-testid="sidebar-view-agents"]')).toBeNull();
		expect(host.querySelector('[data-testid="sidebar-view-chats"]')).toBeNull();
		expect(host.querySelector("[data-testid='device-rail']")).toBeNull();
		expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("/api/v2/code"))).toEqual(
			[]
		);
	});
});
