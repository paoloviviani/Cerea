import ChatInput from "./ChatInput.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { page } from "@vitest/browser/context";
import { writable } from "svelte/store";
import { connectors, connectorsFailed, connectorsLoaded } from "$lib/stores/mcpConnectors";
import { allMcpServers } from "$lib/stores/mcpServers";
import type { McpConnectorView } from "$lib/types/McpConnector";

/** The connector list loads over a fetch; a slow CI runner needs more than
 * vi.waitFor's 1s default (a 5s bound still fails fast on a real regression). */
const waitSlow = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 5000 });

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
	attached: { id: string; name: string }[] = [],
	webSearch = false,
	pageData: Record<string, unknown> = {},
	extraProps: Record<string, unknown> = {}
) {
	let host = document.getElementById("app");
	if (!host) {
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	}
	const mounted = renderWithApp(
		ChatInput,
		{ knowledgeBases: attached, mimeTypes: ["text/plain", "image/png"], webSearch, ...extraProps },
		{
			page: {
				params,
				data: { user: { username: "tester" }, loginEnabled: true, ...pageData },
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
	allMcpServers.set([]);
	for (let i = localStorage.length - 1; i >= 0; i--) {
		const key = localStorage.key(i);
		if (key?.includes(":mcp:")) localStorage.removeItem(key);
	}
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.getElementById("app")?.remove();
});

/** The submenu trigger labelled `label`. Ancestor containers' text can start
 * with the same label, and clicking one of those is a no-op, so take the
 * shortest match: the trigger itself. */
const submenuTrigger = (label: string): HTMLElement | undefined =>
	[...document.body.querySelectorAll<HTMLElement>("div")]
		.filter((el) => el.textContent?.trim().startsWith(label))
		.sort((a, b) => (a.textContent?.trim().length ?? 0) - (b.textContent?.trim().length ?? 0))[0];

const openMenu = async (container: HTMLElement) => {
	fireTap(find(container, 'button[aria-label="Add attachment"]'));
	await waitSlow(() => expect(document.body.textContent).toContain("Knowledge bases"));
};

const openKnowledgeSubmenu = async (_container: HTMLElement) => {
	const trigger = submenuTrigger("Knowledge bases");
	if (!trigger) throw new Error("no knowledge submenu trigger");
	trigger.click();
	await waitSlow(() => expect(document.body.textContent).toContain("Specs"));
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

		await waitSlow(() =>
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

		await waitSlow(() =>
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

		await waitSlow(() => expect(item.getAttribute("aria-checked")).toBe("false"));
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

		await waitSlow(() => expect(item.getAttribute("aria-checked")).toBe("true"));
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
				page: { params: {}, data: { loginEnabled: true } },
				baseElement: host,
				context: settingsContext,
			}
		);
		// requireAuthUser() closes the dropdown outright for an anonymous
		// session — the menu itself never opens, so no submenu inside it either.
		fireTap(find(host, 'button[aria-label="Add attachment"]'));
		await waitSlow(() => expect(document.body.textContent).not.toContain("Add text file"));
		expect(document.body.textContent).not.toContain("Knowledge bases");
	});
});

describe("ChatInput: no connectors in the composer (ADR 0104)", () => {
	const notion: McpConnectorView = {
		id: "conn-notion",
		key: "connector:conn-notion",
		enabled: true,
		name: "Notion",
		url: "https://mcp.notion.com/mcp",
		auth: "oauth",
		scope: "user",
		manageable: true,
		connected: true,
		canAuthorize: true,
		updatedAt: new Date().toISOString(),
	};

	it("lists no connectors in the + menu and shows no count pill, however many are on", async () => {
		stubbedConnectors = [notion];
		connectors.set([notion]);
		connectorsLoaded.set(true);
		allMcpServers.set([
			{
				id: "base-search",
				key: "base:search",
				name: "search",
				url: "https://search.example.com/mcp",
				type: "base",
				mode: "locked",
				enabled: true,
			},
		]);
		stubFetch();
		const { container } = await renderComposer({ id: CONV_ID });
		await openMenu(container);
		// The knowledge submenu is still there; the connectors one is gone, and so are the rows
		// and the pill the old picker drew. Switching connectors is Workspace's job.
		expect(submenuTrigger("Knowledge bases")).toBeTruthy();
		expect(submenuTrigger("Connectors")).toBeUndefined();
		expect(document.body.textContent).not.toContain("Notion");
		expect(document.body.textContent).not.toContain("Manage connectors");
		expect(container.querySelector('[data-testid="connectors-pill"]')).toBeNull();
	});
});

describe("ChatInput: composer toolbar order and attach-menu cascade", () => {
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
		await waitSlow(() => expect(document.body.textContent).toContain(waitFor));
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
			stubFetch();
			const { container } = await renderComposer({ id: CONV_ID });
			await openMenu(container);
			await settlePanels();
			expectPanelsInViewport();

			await openSubmenu("Knowledge bases", "Specs");
			expectPanelsInViewport();

			await openSubmenu("Add text file", "Upload from this device");
			expectPanelsInViewport();
		} finally {
			await page.viewport(restoreWidth, restoreHeight);
		}
	});

	describe("ChatInput: web search is per-chat state", () => {
		const findWebSearchPill = (container: HTMLElement): HTMLElement => {
			const pill = [...container.querySelectorAll("button")].find((button) =>
				button.textContent?.includes("Web search")
			);
			if (!pill) throw new Error("no Web search pill");
			return pill as HTMLElement;
		};

		it("is disabled with a reason when the caller has no search backend", async () => {
			const calls = stubFetch();
			const { container } = await renderComposer({ id: CONV_ID }, [], true, {
				webSearchAvailable: false,
			});

			const pill = findWebSearchPill(container) as HTMLButtonElement;
			expect(pill.disabled).toBe(true);
			expect(pill.getAttribute("aria-pressed")).toBe("false");
			expect(pill.title).toBe("Web search isn't set up here yet.");
			pill.click();
			expect(calls.some((call) => call.method === "PATCH")).toBe(false);
		});

		it("points an administrator at where to set it up", async () => {
			stubFetch();
			const { container } = await renderComposer({ id: CONV_ID }, [], false, {
				webSearchAvailable: false,
				gatewayIsAdmin: true,
			});
			expect(findWebSearchPill(container).title).toContain("Admin → Web search");
		});

		it("is enabled when a search backend is granted", async () => {
			stubFetch();
			const { container } = await renderComposer({ id: CONV_ID }, [], false, {
				webSearchAvailable: true,
			});
			expect((findWebSearchPill(container) as HTMLButtonElement).disabled).toBe(false);
		});

		it("toggling on in a chat PATCHes the conversation, never the settings", async () => {
			const calls = stubFetch();
			const { container } = await renderComposer({ id: CONV_ID });

			const pill = findWebSearchPill(container);
			expect(pill.getAttribute("aria-pressed")).toBe("false");
			pill.click();

			await waitSlow(() =>
				expect(calls).toContainEqual({
					method: "PATCH",
					url: expect.stringContaining(`/conversation/${CONV_ID}`),
					body: { webSearch: true },
				})
			);
			expect(pill.getAttribute("aria-pressed")).toBe("true");
			// Settings hold *defaults*: the composer never POSTs them for a chat toggle.
			expect(calls.some((call) => call.url.includes("/settings"))).toBe(false);
		});

		it("toggling off PATCHes false, so an explicit off beats a default of on", async () => {
			const calls = stubFetch();
			const { container } = await renderComposer({ id: CONV_ID }, [], true);

			const pill = findWebSearchPill(container);
			expect(pill.getAttribute("aria-pressed")).toBe("true");
			pill.click();

			await waitSlow(() =>
				expect(calls).toContainEqual({
					method: "PATCH",
					url: expect.stringContaining(`/conversation/${CONV_ID}`),
					body: { webSearch: false },
				})
			);
			expect(pill.getAttribute("aria-pressed")).toBe("false");
		});

		it("a refused toggle rolls back to what the server holds", async () => {
			stubFetch({ patchStatus: 400 });
			const { container } = await renderComposer({ id: CONV_ID });

			const pill = findWebSearchPill(container);
			pill.click();

			await waitSlow(() => expect(pill.getAttribute("aria-pressed")).toBe("false"));
		});

		it("before a conversation exists, toggling stays local and PATCHes nothing", async () => {
			const calls = stubFetch();
			const { container } = await renderComposer({});

			const pill = findWebSearchPill(container);
			pill.click();

			await waitSlow(() => expect(pill.getAttribute("aria-pressed")).toBe("true"));
			expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
		});
	});

	it("on desktop the submenus still cascade to the right of the root menu", async () => {
		const restoreWidth = window.innerWidth;
		const restoreHeight = window.innerHeight;
		await page.viewport(1280, 800);
		try {
			stubFetch();
			const { container } = await renderComposer({ id: CONV_ID });
			await openMenu(container);
			await openSubmenu("Knowledge bases", "Specs");

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

/**
 * The `/` menu's wiring, for a composer that offers commands (the agent
 * composer's case; chat itself passes none and never sees this). The state
 * machine's own rules are unit-tested in `slashCommand.svelte.test.ts`; what
 * is pinned here is the component around it: the panel opens on a leading
 * slash, Tab accepts into the draft, and Enter hands a known command to
 * `onslashcommand` instead of `onsubmit` — while an unknown one still sends.
 */
describe("ChatInput: the / menu", () => {
	const COMMANDS = [
		{ name: "compact", description: "Shorten now", group: "panel" as const },
		{ name: "model", description: "Switch the model", hint: "[model]", group: "panel" as const },
	];

	async function renderSlashComposer(props: {
		onslashcommand: (command: { name: string }, args: string) => void;
		onsubmit: () => void;
	}) {
		let host = document.getElementById("app");
		if (!host) {
			host = document.createElement("div");
			host.id = "app";
			document.body.appendChild(host);
		}
		const mounted = renderWithApp(
			ChatInput,
			{
				slashCommands: COMMANDS,
				...props,
			},
			{
				page: {
					params: {},
					data: { user: { username: "tester" }, loginEnabled: true },
				},
				baseElement: host,
				context: settingsContext,
			}
		);
		return { ...mounted, container: host };
	}

	async function typeDraft(container: HTMLElement, text: string) {
		const box = find(container, "textarea") as HTMLTextAreaElement;
		box.value = text;
		box.dispatchEvent(new Event("input", { bubbles: true }));
		await waitSlow(() =>
			expect(Boolean(document.getElementById("slash-command-listbox"))).toBe(
				text.startsWith("/") && !text.startsWith("//")
			)
		);
		return box;
	}

	it("a leading slash opens the menu; an unknown name still sends as text", async () => {
		const onslashcommand = vi.fn();
		const onsubmit = vi.fn();
		const { container } = await renderSlashComposer({ onslashcommand, onsubmit });

		const box = await typeDraft(container, "/nonsense");
		expect(document.getElementById("slash-command-listbox")).not.toBeNull();

		box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await waitSlow(() => expect(onsubmit).toHaveBeenCalledTimes(1));
		expect(onslashcommand).not.toHaveBeenCalled();
	});

	it("Enter runs a known command instead of sending, and carries its arguments", async () => {
		const onslashcommand = vi.fn();
		const onsubmit = vi.fn();
		const { container } = await renderSlashComposer({ onslashcommand, onsubmit });

		const box = await typeDraft(container, "/compact");
		box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await waitSlow(() =>
			expect(onslashcommand).toHaveBeenCalledWith(
				{ name: "compact", description: "Shorten now", group: "panel" },
				""
			)
		);
		expect(onsubmit).not.toHaveBeenCalled();
	});

	it("Tab accepts the highlighted-or-first result into the draft", async () => {
		const onslashcommand = vi.fn();
		const onsubmit = vi.fn();
		const { container } = await renderSlashComposer({ onslashcommand, onsubmit });

		const box = await typeDraft(container, "/mod");
		box.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		await waitSlow(() => expect(box.value).toBe("/model "));
		// The menu is closed by the accept, and the ghost hint is announced.
		expect(document.getElementById("slash-command-listbox")).toBeNull();
		expect(onslashcommand).not.toHaveBeenCalled();
		expect(onsubmit).not.toHaveBeenCalled();
	});
});

describe("ChatInput: taking a photo", () => {
	const renderMultimodal = async (coarse: boolean) => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn((query: string) => ({
				matches: coarse && query === "(pointer: coarse)",
				media: query,
				addEventListener: () => {},
				removeEventListener: () => {},
			}))
		);
		stubFetch();
		let host = document.getElementById("app");
		if (!host) {
			host = document.createElement("div");
			host.id = "app";
			document.body.appendChild(host);
		}
		const mounted = renderWithApp(
			ChatInput,
			{ mimeTypes: ["text/plain", "image/png"], modelIsMultimodal: true },
			{
				page: {
					params: {},
					data: { user: { username: "tester" }, loginEnabled: true },
				},
				baseElement: host,
				context: settingsContext,
			}
		);
		await tick();
		return mounted;
	};

	it("offers the camera on a touch device, through an input that opens it directly", async () => {
		const { container } = await renderMultimodal(true);
		fireTap(find(container, 'button[aria-label="Add attachment"]'));
		await waitSlow(() => expect(document.body.textContent).toContain("Take photo"));
		const camera = container.querySelector<HTMLInputElement>('input[aria-label="Take photo"]');
		expect(camera?.getAttribute("capture")).toBe("environment");
		expect(camera?.getAttribute("accept")).toBe("image/*");
	});

	it("leaves it out with a mouse, where browsers ignore the camera hint", async () => {
		const { container } = await renderMultimodal(false);
		fireTap(find(container, 'button[aria-label="Add attachment"]'));
		await waitSlow(() => expect(document.body.textContent).toContain("Add image(s)"));
		expect(document.body.textContent).not.toContain("Take photo");
	});
});
