import ChatInput from "./ChatInput.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { page } from "@vitest/browser/context";
import { get, writable } from "svelte/store";
import {
	connectors,
	connectorsFailed,
	connectorsLoaded,
	enabledConnectors,
	selectedConnectorIds,
} from "$lib/stores/mcpConnectors";
import { allMcpServers } from "$lib/stores/mcpServers";
import type { McpConnectorView } from "$lib/types/McpConnector";
import type { MCPServer } from "$lib/types/Tool";

// The composer's MCP stores read `$env/dynamic/public` at module scope; the
// client project runs in a real browser where no SvelteKit env exists.
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const find = (root: ParentNode, selector: string): HTMLElement => {
	const el = root.querySelector<HTMLElement>(selector);
	if (!el) throw new Error(`no element matching ${selector}`);
	return el;
};

/**
 * Open a bits-ui dropdown from a test. Its trigger opens on a *trusted*
 * pointerdown or on Enter — and vitest-browser-svelte's container lives in
 * the page, not in a shadow root, but a synthetic `pointerdown` carries
 * `isTrusted: false` and is ignored. Focusing the trigger and dispatching a
 * synthetic keydown Enter reaches the trigger's own handler, which has no
 * trust check. (Copied from ProjectsBranch's harness, for the same reason.)
 */
const fireTap = (el: HTMLElement) => {
	el.focus();
	el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
};

const stores = [
	{ id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Specs", description: "" },
	{ id: "bbbbbbbbbbbbbbbbbbbbbbbb", name: "Minutes", description: "" },
];

const CONV_ID = "0123456789abcdef01234567";

// What the connectors endpoint answers. Opening the MCP submenu refreshes,
// so the stub has to keep answering the seeded list or the refresh would
// wipe what the test put in the store.
let stubbedConnectors: McpConnectorView[] = [];

function stubFetch(
	overrides: {
		patchStatus?: number;
		connectorsStatus?: number;
		connectors?: McpConnectorView[];
	} = {}
) {
	const calls: Array<{ method: string; url: string; body: unknown }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			const method = init?.method ?? "GET";
			calls.push({ method, url: href, body: init?.body ? JSON.parse(String(init.body)) : null });
			if (href.endsWith("/api/v2/gateway/vector_stores") && method === "GET") {
				return new Response(JSON.stringify({ data: stores }), { status: 200 });
			}
			if (href.endsWith("/api/v2/mcp/connectors") && method === "GET") {
				const status = overrides.connectorsStatus ?? 200;
				if (status !== 200) return new Response("oops", { status });
				return new Response(JSON.stringify({ data: overrides.connectors ?? stubbedConnectors }), {
					status: 200,
				});
			}
			if (href.endsWith(`/conversation/${CONV_ID}`) && method === "PATCH") {
				return new Response(JSON.stringify({ message: "boom" }), {
					status: overrides.patchStatus ?? 200,
				});
			}
			throw new Error(`unexpected fetch: ${method} ${href}`);
		})
	);
	return calls;
}

const settingsContext = new Map<string, unknown>([["settings", writable({ activeModel: "m" })]]);

async function renderComposer(
	params: Record<string, string>,
	attached: { id: string; name: string }[] = []
) {
	let host = document.getElementById("app");
	if (!host) {
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	}
	const mounted = renderWithApp(
		ChatInput,
		{ knowledgeBases: attached, mimeTypes: ["text/plain", "image/png"] },
		{
			page: {
				params,
				data: { user: { username: "tester" }, loginEnabled: true, shared: false },
			},
			baseElement: host,
			context: settingsContext,
		}
	);
	return { ...mounted, container: host };
}

beforeEach(() => {
	document.getElementById("app")?.remove();
	// Connector and base-server stores persist across tests in this file;
	// reset them so each submenu test starts from what it seeds.
	stubbedConnectors = [];
	connectors.set([]);
	connectorsLoaded.set(false);
	connectorsFailed.set(false);
	selectedConnectorIds.set(new Set());
	allMcpServers.set([]);
	localStorage.removeItem("pystino:mcp:selected-connector-ids");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.getElementById("app")?.remove();
});

const openMenu = async (container: HTMLElement) => {
	fireTap(find(container, 'button[aria-label="Add attachment"]'));
	await vi.waitFor(() => expect(document.body.textContent).toContain("Knowledge bases"));
};

const openKnowledgeSubmenu = async (_container: HTMLElement) => {
	const trigger = [...document.body.querySelectorAll("div")].find((el) =>
		el.textContent?.trim().startsWith("Knowledge bases")
	);
	if (!trigger) throw new Error("no knowledge submenu trigger");
	trigger.click();
	await vi.waitFor(() => expect(document.body.textContent).toContain("Specs"));
};

describe("ChatInput: attaching knowledge bases", () => {
	it("lists the caller's bases in the submenu and toggles one on with a PATCH", async () => {
		const calls = stubFetch();
		const { container } = await renderComposer({ id: CONV_ID });
		await openMenu(container);
		await openKnowledgeSubmenu(container);

		const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
			(el) => el.textContent?.includes("Specs")
		);
		if (!item) throw new Error("no Specs checkbox item");
		expect(item.getAttribute("aria-checked")).toBe("false");
		item.click();

		await vi.waitFor(() =>
			expect(calls).toContainEqual({
				method: "PATCH",
				url: expect.stringContaining(`/conversation/${CONV_ID}`),
				body: { knowledgeBaseIds: ["aaaaaaaaaaaaaaaaaaaaaaaa"] },
			})
		);
		expect(item.getAttribute("aria-checked")).toBe("true");
	});

	it("toggling off sends the shortened list", async () => {
		const calls = stubFetch();
		const { container } = await renderComposer({ id: CONV_ID }, [
			{ id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Specs" },
		]);
		await openMenu(container);
		await openKnowledgeSubmenu(container);

		const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
			(el) => el.textContent?.includes("Specs")
		);
		if (!item) throw new Error("no Specs checkbox item");
		expect(item.getAttribute("aria-checked")).toBe("true");
		item.click();

		await vi.waitFor(() =>
			expect(calls).toContainEqual({
				method: "PATCH",
				url: expect.stringContaining(`/conversation/${CONV_ID}`),
				body: { knowledgeBaseIds: [] },
			})
		);
		expect(item.getAttribute("aria-checked")).toBe("false");
	});

	it("a refused attach rolls the toggle back", async () => {
		stubFetch({ patchStatus: 400 });
		const { container } = await renderComposer({ id: CONV_ID });
		await openMenu(container);
		await openKnowledgeSubmenu(container);

		const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
			(el) => el.textContent?.includes("Specs")
		);
		if (!item) throw new Error("no Specs checkbox item");
		item.click();

		await vi.waitFor(() => expect(item.getAttribute("aria-checked")).toBe("false"));
	});

	it("before a conversation exists, toggling stays local and PATCHes nothing", async () => {
		const calls = stubFetch();
		const { container } = await renderComposer({});
		await openMenu(container);
		await openKnowledgeSubmenu(container);

		const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
			(el) => el.textContent?.includes("Specs")
		);
		if (!item) throw new Error("no Specs checkbox item");
		item.click();

		await vi.waitFor(() => expect(item.getAttribute("aria-checked")).toBe("true"));
		expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
	});

	it("an anonymous composer never reaches the knowledge submenu", async () => {
		stubFetch();
		let host = document.getElementById("app");
		if (!host) {
			host = document.createElement("div");
			host.id = "app";
			document.body.appendChild(host);
		}
		renderWithApp(
			ChatInput,
			{ mimeTypes: ["text/plain", "image/png"] },
			{
				page: { params: {}, data: { loginEnabled: true, shared: false } },
				baseElement: host,
				context: settingsContext,
			}
		);
		// requireAuthUser() closes the dropdown outright for an anonymous
		// session — the menu itself never opens, so no submenu inside it either.
		fireTap(find(host, 'button[aria-label="Add attachment"]'));
		await vi.waitFor(() => expect(document.body.textContent).not.toContain("Add text file"));
		expect(document.body.textContent).not.toContain("Knowledge bases");
	});
});

describe("ChatInput: MCP connector toggles", () => {
	const notionConnector: McpConnectorView = {
		id: "conn-notion",
		name: "Notion",
		url: "https://mcp.notion.com/mcp",
		auth: "oauth",
		scope: "user",
		manageable: true,
		connected: true,
		canAuthorize: true,
		updatedAt: new Date().toISOString(),
	};
	const pendingConnector: McpConnectorView = {
		id: "conn-pending",
		name: "Pending",
		url: "https://mcp.example.com/mcp",
		auth: "oauth",
		scope: "user",
		manageable: true,
		connected: false,
		canAuthorize: true,
		updatedAt: new Date().toISOString(),
	};

	function seedConnectors(list: McpConnectorView[], selected: string[] = []) {
		stubbedConnectors = list;
		connectors.set(list);
		connectorsLoaded.set(true);
		connectorsFailed.set(false);
		selectedConnectorIds.set(new Set(selected));
	}

	const openMcpSubmenu = async () => {
		const trigger = [...document.body.querySelectorAll("div")].find((el) =>
			el.textContent?.trim().startsWith("MCP Servers")
		);
		if (!trigger) throw new Error("no MCP submenu trigger");
		trigger.click();
	};

	const findConnectorItem = (name: string): HTMLElement => {
		const item = [
			...document.body.querySelectorAll<HTMLElement>(
				'[role="menuitemcheckbox"], [role="menuitem"]'
			),
		].find((el) => el.textContent?.includes(name));
		if (!item) throw new Error(`no menu item for ${name}`);
		return item;
	};

	it("toggling a connector off removes it from the set a turn would send", async () => {
		seedConnectors([notionConnector], ["conn-notion"]);
		stubFetch();
		const { container } = await renderComposer({ id: CONV_ID });
		await openMenu(container);
		await openMcpSubmenu();

		await vi.waitFor(() =>
			expect(findConnectorItem("Notion").getAttribute("aria-checked")).toBe("true")
		);
		findConnectorItem("Notion").click();

		await vi.waitFor(() =>
			expect(findConnectorItem("Notion").getAttribute("aria-checked")).toBe("false")
		);
		expect(get(selectedConnectorIds).has("conn-notion")).toBe(false);
		// The turn posts the enabled set, so an off connector sends no tools.
		expect(get(enabledConnectors)).toEqual([]);
		expect(localStorage.getItem("pystino:mcp:selected-connector-ids")).toBe("[]");
	});

	it("toggling a connector on adds it to the set a turn would send", async () => {
		seedConnectors([notionConnector], []);
		stubFetch();
		const { container } = await renderComposer({ id: CONV_ID });
		await openMenu(container);
		await openMcpSubmenu();

		await vi.waitFor(() =>
			expect(findConnectorItem("Notion").getAttribute("aria-checked")).toBe("false")
		);
		findConnectorItem("Notion").click();

		await vi.waitFor(() =>
			expect(findConnectorItem("Notion").getAttribute("aria-checked")).toBe("true")
		);
		expect(get(enabledConnectors).map((c) => c.id)).toEqual(["conn-notion"]);
		expect(localStorage.getItem("pystino:mcp:selected-connector-ids")).toBe('["conn-notion"]');
	});

	it("loads the list when the submenu opens", async () => {
		// Nothing seeded: the refresh on open is what fills the list.
		stubbedConnectors = [notionConnector];
		connectors.set([]);
		connectorsLoaded.set(false);
		stubFetch();
		const { container } = await renderComposer({ id: CONV_ID });
		await openMenu(container);
		await openMcpSubmenu();

		await vi.waitFor(() => expect(document.body.textContent).toContain("Loading connectors…"));
		await vi.waitFor(() =>
			expect(findConnectorItem("Notion").getAttribute("aria-checked")).toBe("false")
		);
	});

	it("a disconnected connector offers sign-in through the manager instead of selecting", async () => {
		seedConnectors([pendingConnector], []);
		stubFetch();
		const { container } = await renderComposer({ id: CONV_ID });
		await openMenu(container);
		await openMcpSubmenu();

		await vi.waitFor(() =>
			expect(findConnectorItem("Pending").textContent).toContain("Not signed in")
		);
		expect(findConnectorItem("Pending").getAttribute("role")).toBe("menuitem");
		findConnectorItem("Pending").click();

		// The manager dialog opens (where the sign-in lives)…
		await vi.waitFor(() =>
			expect(
				[...document.body.querySelectorAll("h2")].some((el) =>
					el.textContent?.includes("MCP Servers")
				)
			).toBe(true)
		);
		// …and nothing was selected: a no-op toggle would send no tools.
		expect(get(selectedConnectorIds).size).toBe(0);
		expect(get(enabledConnectors)).toEqual([]);
	});

	it("with no connectors the submenu says where to add one, keeping the manager row", async () => {
		seedConnectors([], []);
		stubFetch();
		const { container } = await renderComposer({ id: CONV_ID });
		await openMenu(container);
		await openMcpSubmenu();

		await vi.waitFor(() =>
			expect(document.body.textContent).toContain(
				"No connectors yet. Add one from Manage MCP Servers."
			)
		);
		expect(document.body.textContent).toContain("Manage MCP Servers");
	});

	it("a failed load says so instead of pretending there is nothing", async () => {
		seedConnectors([], []);
		stubFetch({ connectorsStatus: 500 });
		const { container } = await renderComposer({ id: CONV_ID });
		await openMenu(container);
		await openMcpSubmenu();

		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("Could not load connectors")
		);
		expect(document.body.textContent).toContain("Manage MCP Servers");
	});
});

describe("ChatInput: composer toolbar order and attach-menu cascade", () => {
	const pendingConnector: McpConnectorView = {
		id: "conn-pending",
		name: "Pending",
		url: "https://mcp.example.com/mcp",
		auth: "oauth",
		scope: "user",
		manageable: true,
		connected: false,
		canAuthorize: true,
		updatedAt: new Date().toISOString(),
	};

	const baseServer: MCPServer = {
		id: "srv-base",
		name: "Base Server With A Long Name",
		url: "https://mcp.base.example/mcp",
		type: "base",
	};

	const openSubmenu = async (name: string, waitFor: string) => {
		// Ancestor containers also start with the label (their textContent
		// includes it), so pick the shortest match: the trigger itself, whose
		// trimmed text is exactly the label. Clicking an ancestor is a no-op.
		const candidates = [...document.body.querySelectorAll("div")]
			.filter((el) => el.textContent?.trim().startsWith(name))
			.sort((a, b) => (a.textContent?.trim().length ?? 0) - (b.textContent?.trim().length ?? 0));
		const trigger = candidates[0];
		if (!trigger) throw new Error(`no ${name} submenu trigger`);
		trigger.click();
		await vi.waitFor(() => expect(document.body.textContent).toContain(waitFor));
		await settlePanels();
	};

	const panelRects = (): string[] =>
		[...document.body.querySelectorAll<HTMLElement>('[role="menu"]')].map((menu) => {
			const r = menu.getBoundingClientRect();
			return [r.left, r.right, r.top, r.bottom].join(",");
		});

	// floating-ui positions async; wait until every open panel stops moving so
	// the assertions below measure the settled cascade, not a transient.
	async function settlePanels() {
		for (let i = 0; i < 20; i++) {
			const before = panelRects().join("|");
			await new Promise((resolve) => setTimeout(resolve, 40));
			const after = panelRects().join("|");
			if (before.length > 0 && before === after) return;
		}
		throw new Error("attach-menu panels never settled");
	}

	function expectPanelsInViewport() {
		const panels = [...document.body.querySelectorAll<HTMLElement>('[role="menu"]')];
		expect(panels.length).toBeGreaterThan(0);
		for (const panel of panels) {
			const r = panel.getBoundingClientRect();
			expect(r.left, "panel past the left viewport edge").toBeGreaterThanOrEqual(0);
			expect(r.right, "panel past the right viewport edge").toBeLessThanOrEqual(window.innerWidth);
			expect(r.top, "panel past the top viewport edge").toBeGreaterThanOrEqual(0);
			expect(r.bottom, "panel past the bottom viewport edge").toBeLessThanOrEqual(
				window.innerHeight
			);
		}
	}

	it("puts the attach trigger before the Web search pill", async () => {
		stubFetch();
		const { container } = await renderComposer({ id: CONV_ID });
		const attach = find(container, 'button[aria-label="Add attachment"]');
		const webSearch = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Web search")
		);
		if (!webSearch) throw new Error("no Web search pill");
		expect(
			attach.compareDocumentPosition(webSearch) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it("at phone width, the root menu and every submenu stay inside the viewport", async () => {
		const restoreWidth = window.innerWidth;
		const restoreHeight = window.innerHeight;
		await page.viewport(390, 844);
		try {
			// A wide MCP flyout (base server plus a "Not signed in" connector
			// row) is what used to extend past the left edge here.
			stubbedConnectors = [pendingConnector];
			connectors.set([pendingConnector]);
			connectorsLoaded.set(true);
			stubFetch();
			allMcpServers.set([baseServer]);
			const { container } = await renderComposer({ id: CONV_ID });
			await openMenu(container);
			await settlePanels();
			expectPanelsInViewport();

			await openSubmenu("MCP Servers", "Not signed in");
			expectPanelsInViewport();

			await openSubmenu("Knowledge bases", "Specs");
			expectPanelsInViewport();

			await openSubmenu("Add text file", "Upload from device");
			expectPanelsInViewport();
		} finally {
			await page.viewport(restoreWidth, restoreHeight);
		}
	});

	it("on desktop the submenus still cascade to the right of the root menu", async () => {
		const restoreWidth = window.innerWidth;
		const restoreHeight = window.innerHeight;
		await page.viewport(1280, 800);
		try {
			stubbedConnectors = [pendingConnector];
			connectors.set([pendingConnector]);
			connectorsLoaded.set(true);
			stubFetch();
			allMcpServers.set([baseServer]);
			const { container } = await renderComposer({ id: CONV_ID });
			await openMenu(container);
			await openSubmenu("MCP Servers", "Not signed in");

			const panels = [...document.body.querySelectorAll<HTMLElement>('[role="menu"]')];
			const submenu = panels[panels.length - 1];
			if (!submenu) throw new Error("no submenu panel");
			expect(submenu.getAttribute("data-side")).toBe("right");
			expect(submenu.getAttribute("data-align")).toBe("center");
			expectPanelsInViewport();
		} finally {
			await page.viewport(restoreWidth, restoreHeight);
		}
	});
});
