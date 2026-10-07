import NavMenu from "./NavMenu.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import superjson from "superjson";
import { codeReauth, resetCodeReauth, flagCodeReauth } from "$lib/stores/codeReauth.svelte";
import { codeNav } from "$lib/stores/codeNav.svelte";
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

	function mount(user: object | null, gatewayIsAdmin = false) {
		return renderWithApp(NavMenu, { conversations: [], user, gatewayIsAdmin } as never, {
			page: { data: { models: [] } },
			baseElement: host,
		});
	}

	it("rows point at the workspace and the settings, and no manager rows remain", () => {
		mount({ username: "ada" });

		expect(host.querySelector('a[href="/workspace"]')).not.toBeNull();
		expect(host.querySelector('a[href="/settings/application"]')).not.toBeNull();
		// Strip the tags: a row's label may be followed by other nodes.
		const text = (host.textContent ?? "").replace(/\s+/g, " ");
		expect(text).not.toContain("Knowledge");
		expect(text).not.toContain("MCP Servers");
		expect(host.querySelector("[aria-haspopup]")).toBeNull();
	});

	it("the Admin row renders only for an administrator", () => {
		const notAdmin = mount({ username: "ada" }, false);
		expect((host.textContent ?? "").includes("Admin")).toBe(false);
		notAdmin.unmount();

		mount({ username: "ada" }, true);
		expect(host.querySelector('a[href="/admin"]')).not.toBeNull();
	});

	it("the signed-out panel keeps the rows and has no footer", () => {
		mount(null);

		expect(host.querySelector('a[href="/workspace"]')).not.toBeNull();
		expect(host.querySelector('a[href="/settings/application"]')).not.toBeNull();
		expect(host.querySelector("form")).toBeNull();
	});

	it("the footer names the person and posts the sign-out", () => {
		const screen = mount({ username: "ada" });

		expect(screen.getByText("ada")).toBeInTheDocument();
		const form = host.querySelector('form[action="/logout"]');
		expect(form).not.toBeNull();
		expect(form?.getAttribute("method")).toBe("POST");
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
					[ACTIVE_GENERATIONS_CONTEXT_KEY, { has: () => false, statusFor: () => undefined }],
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

	function mount() {
		return renderWithApp(
			NavMenu,
			{
				conversations: [],
				user: { username: "ada" },
				gatewayIsAdmin: false,
				codeAgentsEnabled: true,
			} as never,
			{ page: { route: { id: "/code" }, data: { models: [] } }, baseElement: host }
		);
	}

	beforeEach(() => {
		resetCodeReauth();
		codeNav.view = "auto";
		listDevices.mockReset();
		listDevices.mockResolvedValue({ devices: [] });
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetCodeReauth();
		host.remove();
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
		expect((host.textContent ?? "").replace(/\s+/g, " ")).not.toContain("Pair a machine");
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
		await vi.waitFor(() => expect(host.textContent).toContain("Pair a device"));
		const calls = listDevices.mock.calls.length;
		flagCodeReauth();
		await vi.waitFor(() => expect(host.textContent).not.toContain("Pair a device"));
		expect(host.querySelector('[data-testid="sidebar-view-agents"]')).not.toBeNull();
		expect(listDevices.mock.calls.length).toBe(calls);
	});
});
