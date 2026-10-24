/**
 * The project page: the two tabs (conversations by default, settings behind
 * `?tab=settings` — `/projects/new` has no tab bar), and the things that used
 * to need the overlay's nested Edit — attaching a knowledge base after the
 * project exists, removing a chat, the defaults for new chats — plus the
 * documents section's refusal of a dropped folder.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page } from "@vitest/browser/context";

import ProjectPage from "./ProjectPage.svelte";
import { renderWithApp, appNavigation } from "$lib/components/__tests__/renderWithApp";
import {
	connectors,
	connectorsLoaded,
	resetConversationSelections,
} from "$lib/stores/mcpConnectors";
import type { McpConnectorView } from "$lib/types/McpConnector";
import type { ProjectView } from "$lib/types/Project";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

function connector(overrides: Partial<McpConnectorView> & { id: string }): McpConnectorView {
	return {
		name: `Server ${overrides.id}`,
		url: `https://${overrides.id}.test/mcp`,
		auth: "none",
		scope: "user",
		manageable: true,
		connected: true,
		canAuthorize: false,
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

const CONN_ON = () => connector({ id: "conn-a", name: "notion", auth: "oauth", connected: true });
const CONN_OFF = () =>
	connector({ id: "conn-b", name: "drive", auth: "oauth", connected: false, canAuthorize: true });

function projectView(overrides: Partial<ProjectView> = {}): ProjectView {
	return {
		id: "proj-1",
		name: "Grant application",
		description: "",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: false,
		hasMemory: false,
		retrievalLimit: 6,
		owned: true,
		shares: [],
		conversationCount: 0,
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

const STORES = [
	{ id: "a".repeat(24), name: "Call texts", file_counts: { completed: 3 }, owned: true },
	{ id: "b".repeat(24), name: "Past proposals", file_counts: { completed: 9 }, owned: false },
];

const CHATS = [
	{
		id: "c1",
		title: "Budget questions",
		model: "m",
		updatedAt: "2026-01-01T00:00:00Z",
		mine: true,
	},
	{ id: "c2", title: "Their thread", model: "m", updatedAt: "2026-01-01T00:00:00Z", mine: false },
];

function settingsContext(webSearchEnabled: boolean) {
	const store = writable({ activeModel: "m", webSearchEnabled });
	return {
		context: new Map<unknown, unknown>([
			["settings", { subscribe: store.subscribe, update: store.update }],
		]),
	};
}

interface SeenCall {
	method: string;
	url: string;
	body: unknown;
}

function stubApi(
	options: {
		connectors?: McpConnectorView[];
		project?: ProjectView | null;
		chats?: typeof CHATS;
	} = {}
) {
	const seen: SeenCall[] = [];
	let current = options.project ?? null;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			const body =
				typeof init?.body === "string" && init.body ? JSON.parse(init.body) : (init?.body ?? null);
			if (url.endsWith("/api/v2/mcp/connectors") && method === "GET") {
				return Response.json({ data: options.connectors ?? [CONN_ON(), CONN_OFF()] });
			}
			if (url.includes("/api/v2/gateway/vector_stores") && method === "GET") {
				return Response.json({ data: STORES });
			}
			if (url.includes("/api/v2/gateway/billing/groups")) return Response.json({ data: [] });
			if (/\/projects\/[^/]+\/documents$/.test(url) && method === "GET") {
				return Response.json({ data: { documents: [], usedChars: 0 } });
			}
			if (/\/projects\/[^/]+\/memory$/.test(url) && method === "GET") {
				return Response.json({ data: { notes: [] } });
			}
			if (/\/projects\/[^/]+\/conversations$/.test(url) && method === "GET") {
				return Response.json({ data: options.chats ?? [] });
			}
			if (url.endsWith("/api/v2/projects") && method === "GET") {
				return Response.json({
					data: [projectView(), projectView({ id: "proj-2", name: "Annual report" })],
				});
			}
			if (/\/api\/v2\/conversations\/[^/]+$/.test(url) && method === "PATCH") {
				seen.push({ method, url, body });
				return Response.json({ success: true });
			}
			if (/\/projects\/[^/]+\/conversations\/[^/]+$/.test(url) && method === "DELETE") {
				seen.push({ method, url, body });
				return new Response(null, { status: 204 });
			}
			if (url.endsWith("/api/v2/projects") && method === "POST") {
				seen.push({ method, url, body });
				return Response.json(projectView({ ...(body as object), id: "proj-new" }), {
					status: 201,
				});
			}
			if (/\/api\/v2\/projects\/[^/]+$/.test(url) && method === "GET") {
				return current ? Response.json(current) : new Response("nope", { status: 404 });
			}
			if (/\/api\/v2\/projects\/[^/]+$/.test(url) && method === "PATCH") {
				seen.push({ method, url, body });
				current = projectView({ ...(current ?? {}), ...(body as object) });
				return Response.json(current);
			}
			throw new Error(`unexpected fetch: ${method} ${url}`);
		})
	);
	return seen;
}

function mountCreate(webSearchEnabled: boolean) {
	return renderWithApp(ProjectPage, {} as never, {
		page: { data: { models: [{ id: "m" }] } },
		context: settingsContext(webSearchEnabled).context,
	});
}

function mountExisting(webSearchEnabled = false, tab?: "settings") {
	return renderWithApp(ProjectPage, { id: "proj-1" } as never, {
		page: {
			url: tab ? `/projects/proj-1?tab=${tab}` : "/projects/proj-1",
			data: { models: [{ id: "m" }] },
		},
		context: settingsContext(webSearchEnabled).context,
	});
}

function switchControl(name: string): HTMLElement {
	const input = document.body.querySelector(`input[name="${name}"]`);
	if (!input) throw new Error(`no switch input named ${name}`);
	const control = input.nextElementSibling;
	if (!(control instanceof HTMLElement)) throw new Error(`no switch control for ${name}`);
	return control;
}

async function flipSwitch(name: string): Promise<void> {
	const switches = page.getByRole("switch");
	const count = switches.elements().length;
	for (let index = 0; index < count; index++) {
		const element = switches.nth(index).elements()[0] as HTMLElement | undefined;
		if (element?.previousElementSibling?.getAttribute("name") === name) {
			await switches.nth(index).click();
			return;
		}
	}
	switchControl(name).click();
}

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
	[...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as
		HTMLButtonElement | undefined;
const byLabel = (label: string) =>
	document.body.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;

async function waitForText(fragment: string) {
	await vi.waitFor(() => {
		if (!text().includes(fragment)) throw new Error(`not yet shown: ${fragment}`);
	});
}

async function typeInto(selector: string, value: string) {
	const element = document.body.querySelector(selector) as HTMLInputElement;
	element.focus();
	element.value = value;
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
	connectors.set([]);
	connectorsLoaded.set(false);
	resetConversationSelections();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("ProjectPage tabs", () => {
	it("opens on the conversations tab: the chats are shown, the settings are not", async () => {
		stubApi({ project: projectView({ conversationCount: 2 }), chats: CHATS });
		mountExisting();
		await waitForText("Budget questions");

		expect(text()).toContain("Chats (2)");
		expect(byLabel("Actions for Budget questions")).not.toBeNull();
		expect(document.body.querySelector("#project-name")).toBeNull();
		expect(document.body.querySelector('[aria-label="Standing instructions"]')).toBeNull();
		expect(document.body.querySelector('[data-testid="project-knowledge"]')).toBeNull();

		// The tab bar is the workspace's: two links, the active one marked.
		const tabs = [...document.body.querySelectorAll('nav[aria-label="Project sections"] a')];
		expect(tabs.map((a) => a.textContent?.trim())).toEqual(["Conversations", "Settings"]);
		expect(tabs[0].getAttribute("aria-current")).toBe("page");
		expect(tabs[0].getAttribute("href")).toBe("/projects/proj-1");
		expect(tabs[1].getAttribute("href")).toBe("/projects/proj-1?tab=settings");
	});

	it("/projects/new has no tab bar: everything it makes is settings", async () => {
		stubApi({});
		mountCreate(false);
		await waitForText("Web search on by default");
		expect(document.body.querySelector('nav[aria-label="Project sections"]')).toBeNull();
	});
});

describe("ProjectPage sections", () => {
	it("draws the five context levels and every section of an existing project", async () => {
		stubApi({ project: projectView({ name: "Grant application" }), chats: CHATS });
		mountExisting(false, "settings");
		await waitForText("Context documents (0)");

		// The explainer lists the five levels, in prompt order.
		const explainer = document.body.querySelector("[aria-labelledby='project-levels']");
		const levels = [...(explainer?.querySelectorAll("li") ?? [])].map((li) => li.textContent);
		expect(levels).toHaveLength(5);
		[
			"Standing instructions",
			"Context documents",
			"Project memory",
			"Knowledge bases",
			"Past chats",
		].forEach((title, index) => expect(levels[index]).toContain(title));

		expect(document.body.querySelector("h1")?.textContent).toContain("Grant application");
		expect(document.body.querySelector("#project-name")).not.toBeNull();
		expect(document.body.querySelector('[aria-label="Standing instructions"]')).not.toBeNull();
		expect(document.body.querySelector('[data-testid="project-documents"]')).not.toBeNull();
		expect(document.body.querySelector('[data-testid="project-knowledge"]')).not.toBeNull();
		expect(text()).toContain("Share it");
		expect(text()).toContain("Defaults for new chats here");
		expect(text()).toContain("Passages per answer");
		expect(text()).toContain("Web search on by default");
		// The settings tab does not carry the conversations: they are the other
		// tab's content, reached without remounting the page.
		expect(text()).not.toContain("Chats (2)");
	});

	it("a shared project is read-only for its settings", async () => {
		stubApi({ project: projectView({ owned: false }), chats: CHATS });
		mountExisting(false, "settings");
		await waitForText("Context documents (0)");
		expect((document.body.querySelector("#project-name") as HTMLInputElement).disabled).toBe(true);
		expect(text()).not.toContain("Share it");
		expect(button("Save changes")).toBeUndefined();
		expect(document.body.querySelector('[data-testid="project-documents"]')).not.toBeNull();
	});

	it("a shared project still lists its chats, with actions only for one's own", async () => {
		stubApi({ project: projectView({ owned: false }), chats: CHATS });
		mountExisting();
		await waitForText("Budget questions");
		// Not theirs, not the owner's: no removal for the chat they did not start.
		expect(byLabel("Actions for Budget questions")).not.toBeNull();
		expect(byLabel("Remove Their thread from project")).toBeNull();
	});
});

describe("ProjectPage knowledge bases, after creation", () => {
	it("attaches a base to an existing project at once, and detaches it again", async () => {
		const seen = stubApi({ project: projectView() });
		mountExisting(false, "settings");
		await waitForText("No knowledge bases attached");
		// The candidate bases load separately from the project: clicking before the
		// button exists would do nothing (`?.click()`) and the test would wait in vain.
		await vi.waitFor(() => expect(byLabel("Attach Call texts")).not.toBeNull());

		byLabel("Attach Call texts")?.click();
		await vi.waitFor(() => expect(seen.some((call) => call.method === "PATCH")).toBe(true));
		expect(seen[0].body).toEqual({ knowledgeBaseIds: ["a".repeat(24)] });
		await waitForText("Knowledge bases (1)");
		expect(byLabel("Detach Call texts")).not.toBeNull();
		// An attached base leaves the list of candidates.
		expect(byLabel("Attach Call texts")).toBeNull();

		// The attach is still being saved while its button is disabled.
		await vi.waitFor(() =>
			expect((byLabel("Detach Call texts") as HTMLButtonElement | null)?.disabled).toBe(false)
		);
		byLabel("Detach Call texts")?.click();
		await vi.waitFor(() => expect(seen).toHaveLength(2));
		expect(seen[1].body).toEqual({ knowledgeBaseIds: [] });
	});

	it("searches the list, and links to the workspace to create a base", async () => {
		stubApi({ project: projectView() });
		mountExisting(false, "settings");
		await waitForText("Call texts");
		await typeInto("#project-kb-search", "proposals");
		await vi.waitFor(() => expect(byLabel("Attach Call texts")).toBeNull());
		expect(byLabel("Attach Past proposals")).not.toBeNull();
		const link = [...document.body.querySelectorAll("a")].find((a) =>
			a.textContent?.includes("Create a base in the workspace")
		);
		expect(link?.getAttribute("href")).toContain("/workspace?tab=kb");
	});
});

/** Open a row's `⋯` menu the way a pointer does, and return the item named `name`. */
async function menuItem(rowTitle: string, name: string): Promise<HTMLElement> {
	const trigger = byLabel(`Actions for ${rowTitle}`);
	if (!trigger) throw new Error(`no menu for ${rowTitle}`);
	trigger.dispatchEvent(
		new PointerEvent("pointerdown", {
			button: 0,
			bubbles: true,
			cancelable: true,
			pointerType: "mouse",
		})
	);
	let item: HTMLElement | undefined;
	await vi.waitFor(() => {
		item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) =>
			el.textContent?.includes(name)
		) as HTMLElement | undefined;
		if (!item) throw new Error(`no menu item ${name}`);
	});
	return item as HTMLElement;
}

describe("ProjectPage chats", () => {
	it("removes a chat from the project without a native confirm, and keeps the others", async () => {
		const seen = stubApi({ project: projectView({ conversationCount: 2 }), chats: CHATS });
		const confirmSpy = vi.spyOn(window, "confirm");
		mountExisting();
		await waitForText("Budget questions");

		(await menuItem("Budget questions", "Remove from project")).click();
		await vi.waitFor(() => expect(seen.some((call) => call.method === "PATCH")).toBe(true));
		expect(seen[0].url).toContain("/api/v2/conversations/c1");
		expect(seen[0].body).toEqual({ projectId: null });
		await vi.waitFor(() => expect(text()).toContain("Chats (1)"));
		expect(text()).not.toContain("Budget questions");
		expect(text()).toContain("Their thread");
		expect(confirmSpy).not.toHaveBeenCalled();
	});

	it("moves a chat to another project from the picker, which marks the current one", async () => {
		const seen = stubApi({ project: projectView({ conversationCount: 2 }), chats: CHATS });
		mountExisting();
		await waitForText("Budget questions");

		(await menuItem("Budget questions", "Move to project")).click();
		await waitForText("Annual report");
		expect(text()).toContain("None (remove from project)");
		expect(text()).toContain("Current");
		button("Annual report")?.click();
		await vi.waitFor(() => expect(seen.some((call) => call.method === "PATCH")).toBe(true));
		expect(seen[0].body).toEqual({ projectId: "proj-2" });
		await vi.waitFor(() => expect(text()).toContain("Chats (1)"));
		await vi.waitFor(() => expect(text()).not.toContain("Budget questions"));
	});

	it("offers the project's owner removal, but not a move, for a chat someone else started", async () => {
		stubApi({ project: projectView({ conversationCount: 2 }), chats: CHATS });
		mountExisting();
		await waitForText("Their thread");
		const items = await menuItem("Their thread", "Remove from project");
		expect(items).not.toBeNull();
		expect(text()).not.toContain("Move to project…");
	});
});

describe("ProjectPage context documents", () => {
	const fakeItem = (name: string, isDirectory: boolean) => ({
		kind: "file",
		webkitGetAsEntry: () => ({ isDirectory }),
		getAsFile: () => new File(["x"], name),
	});

	function drop(items: ReturnType<typeof fakeItem>[]) {
		const zone = document.body.querySelector(
			'[data-testid="project-documents-drop"]'
		) as HTMLElement;
		const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
			dataTransfer: unknown;
		};
		event.dataTransfer = { items, files: [] };
		zone.dispatchEvent(event);
	}

	it("refuses a dropped folder with the reason, and uploads nothing", async () => {
		const seen = stubApi({ project: projectView() });
		mountExisting(false, "settings");
		await waitForText("No documents yet");

		drop([fakeItem("papers", true)]);
		await waitForText("Folders can't be added");
		expect(text()).toContain("Whole documents go into every prompt");
		expect(seen).toHaveLength(0);
	});

	it("offers a file picker for files only: multiple, and no directory selection", async () => {
		stubApi({ project: projectView() });
		mountExisting(false, "settings");
		await waitForText("No documents yet");
		const input = document.body.querySelector(
			'[data-testid="project-documents-input"]'
		) as HTMLInputElement;
		expect(input.multiple).toBe(true);
		expect(input.hasAttribute("webkitdirectory")).toBe(false);
	});
});

describe("ProjectPage defaults for new chats", () => {
	it("create page uses toggles with the exact simplified texts and no old wording", async () => {
		stubApi({ connectors: [CONN_ON(), CONN_OFF()] });
		mountCreate(false);
		await waitForText("Web search on by default");
		await vi.waitFor(() =>
			expect(
				document.body.querySelector('input[name="project-default-connector-conn-a"]')
			).not.toBeNull()
		);
		expect(text()).toContain("MCPs on by default:");
		expect(text()).toContain("· not signed in");
		for (const banned of [
			"Use the app default",
			"Checked connectors start on",
			"None checked means",
			"A chat's own toggle still wins",
			"A chat's own picker still wins",
			"workspace MCP",
			"app default",
			"workspace defaults",
		]) {
			expect(text(), `banned wording: ${banned}`).not.toContain(banned);
		}
		// Nothing exists to attach documents or memory to yet.
		expect(document.body.querySelector('[data-testid="project-documents"]')).toBeNull();
	});

	it("seeds the web-search toggle from the app default, on and off", async () => {
		stubApi({});
		mountCreate(true);
		await waitForText("Web search on by default");
		await vi.waitFor(() =>
			expect(switchControl("project-default-websearch").getAttribute("aria-checked")).toBe("true")
		);
		document.body.innerHTML = "";
		mountCreate(false);
		await waitForText("Web search on by default");
		await vi.waitFor(() =>
			expect(switchControl("project-default-websearch").getAttribute("aria-checked")).toBe("false")
		);
	});

	it("an existing project seeds from its stored explicit values", async () => {
		stubApi({
			project: projectView({ defaultWebSearch: false, defaultMcpConnectorIds: ["conn-a"] }),
		});
		mountExisting(true, "settings");
		await waitForText("MCPs on by default:");
		await vi.waitFor(() =>
			expect(
				document.body.querySelector('input[name="project-default-connector-conn-a"]')
			).not.toBeNull()
		);
		expect(switchControl("project-default-websearch").getAttribute("aria-checked")).toBe("false");
		expect(switchControl("project-default-connector-conn-a").getAttribute("aria-checked")).toBe(
			"true"
		);
		expect(switchControl("project-default-connector-conn-b").getAttribute("aria-checked")).toBe(
			"false"
		);
	});

	it("an existing project without a stored value falls back to the app default", async () => {
		stubApi({ project: projectView() });
		mountExisting(true, "settings");
		await waitForText("Web search on by default");
		await vi.waitFor(() =>
			expect(switchControl("project-default-websearch").getAttribute("aria-checked")).toBe("true")
		);
	});

	it("create saves every setting as an explicit value, then opens the project's page", async () => {
		const seen = stubApi({ connectors: [CONN_ON(), CONN_OFF()] });
		mountCreate(false);
		await waitForText("Web search on by default");
		await vi.waitFor(() =>
			expect(
				document.body.querySelector('input[name="project-default-connector-conn-a"]')
			).not.toBeNull()
		);
		await typeInto("#project-name", "Grant");
		await typeInto("#project-instructions, [aria-label='Standing instructions']", "Be brief.");
		await flipSwitch("project-default-websearch");
		await flipSwitch("project-default-connector-conn-a");
		await vi.waitFor(() =>
			expect(switchControl("project-default-connector-conn-a").getAttribute("aria-checked")).toBe(
				"true"
			)
		);

		button("Create project")?.click();
		await vi.waitFor(() => expect(seen.some((call) => call.method === "POST")).toBe(true));
		expect(seen[0].body).toMatchObject({
			name: "Grant",
			instructions: "Be brief.",
			knowledgeBaseIds: [],
			indexPastChats: false,
			retrievalLimit: 6,
			defaultWebSearch: true,
			defaultMcpConnectorIds: ["conn-a"],
		});
		await vi.waitFor(() =>
			expect(appNavigation().goto).toHaveBeenCalledWith("/projects/proj-new", {
				replaceState: true,
			})
		);
	});

	it("Save appears only when something changed, and sends the changed settings", async () => {
		const seen = stubApi({ project: projectView() });
		mountExisting(false, "settings");
		await waitForText("Passages per answer");
		expect(button("Save changes")?.disabled).toBe(true);

		await typeInto("#project-name", "Renamed");
		await vi.waitFor(() => expect(button("Save changes")?.disabled).toBe(false));
		button("Save changes")?.click();
		await vi.waitFor(() => expect(seen.some((call) => call.method === "PATCH")).toBe(true));
		expect(seen[0].body).toMatchObject({ name: "Renamed" });
		await vi.waitFor(() => expect(text()).toContain("Saved"));
		expect(button("Save changes")?.disabled).toBe(true);
	});
});
