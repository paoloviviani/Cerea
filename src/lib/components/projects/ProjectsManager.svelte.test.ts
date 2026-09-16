/**
 * Project defaults: editable in both create and edit, as toggles.
 *
 * The form always saves an explicit boolean for web search (seeded from the
 * app default when the project has no explicit value); the Project field
 * stays optional so old docs without it still resolve as "follow app
 * default" server-side. MCP rows use the app's Switch, keeping the
 * "not signed in" secondary state.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page } from "@vitest/browser/context";

import ProjectsManager from "./ProjectsManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
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
		retrievalLimit: 6,
		owned: true,
		shares: [],
		conversationCount: 0,
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

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
		list?: ProjectView[];
	} = {}
) {
	const seen: SeenCall[] = [];
	const list = options.list ?? (options.project ? [options.project] : []);
	const connectorList = options.connectors ?? [CONN_ON(), CONN_OFF()];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : null;
			if (url.endsWith("/api/v2/mcp/connectors") && method === "GET") {
				return Response.json({ data: connectorList });
			}
			if (url.includes("/api/v2/gateway/vector_stores") && method === "GET") {
				return Response.json({ data: [] });
			}
			if (url.includes("/api/v2/gateway/billing/groups") && method === "GET") {
				return Response.json({ data: [] });
			}
			if (url.endsWith("/api/v2/projects") && method === "GET") {
				return Response.json({ data: list });
			}
			if (/\/api\/v2\/projects\/[^/]+\/conversations$/.test(url) && method === "GET") {
				return Response.json({ data: [] });
			}
			const detailMatch = url.match(/\/api\/v2\/projects\/([^/]+)$/);
			if (detailMatch && method === "GET") {
				if (!options.project) return new Response("nope", { status: 404 });
				return Response.json(options.project);
			}
			if (url.endsWith("/api/v2/projects") && method === "POST") {
				seen.push({ method, url, body });
				const saved = projectView({
					...(options.project ?? {}),
					id: "proj-1",
					...(body as Record<string, unknown>),
				});
				return Response.json(saved, { status: 201 });
			}
			if (detailMatch && method === "PATCH") {
				seen.push({ method, url, body });
				const saved = projectView({
					...(options.project ?? {}),
					...(body as Record<string, unknown>),
				});
				return Response.json(saved);
			}
			throw new Error(`unexpected fetch: ${method} ${url}`);
		})
	);
	return seen;
}

function mountCreate(webSearchEnabled: boolean) {
	return renderWithApp(ProjectsManager, { initialView: "create", onclose: () => {} } as never, {
		page: { data: { models: [{ id: "m" }] } },
		context: settingsContext(webSearchEnabled).context,
	});
}

function mountDetail(webSearchEnabled: boolean) {
	return renderWithApp(ProjectsManager, { initialId: "proj-1", onclose: () => {} } as never, {
		page: { data: { models: [{ id: "m" }] } },
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

async function waitForForm(): Promise<void> {
	await vi.waitFor(() => {
		if (!document.body.textContent?.includes("Web search on by default")) {
			throw new Error("defaults section not yet shown");
		}
	});
}

async function waitForDetail(): Promise<void> {
	await vi.waitFor(() => {
		if (!document.body.textContent?.includes("Defaults for new chats")) {
			throw new Error("detail not yet shown");
		}
	});
}

describe("ProjectsManager project defaults", () => {
	beforeEach(() => {
		connectors.set([]);
		connectorsLoaded.set(false);
		resetConversationSelections();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	it("create form uses toggles with the exact simplified texts and no old wording", async () => {
		stubApi({ connectors: [CONN_ON(), CONN_OFF()] });
		mountCreate(false);
		await waitForForm();
		await vi.waitFor(() => expect(switchControl("project-default-websearch")).not.toBeNull());
		await vi.waitFor(() =>
			expect(
				document.body.querySelector('input[name="project-default-connector-conn-a"]')
			).not.toBeNull()
		);

		expect(document.body.textContent).toContain("Web search on by default");
		expect(document.body.textContent).toContain("MCPs on by default:");
		expect(document.body.querySelector("select#project-default-websearch")).toBeNull();
		expect(document.body.textContent).toContain("· not signed in");

		const bodyText = document.body.textContent ?? "";
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
			expect(bodyText, `banned wording: ${banned}`).not.toContain(banned);
		}
	});

	it("create form seeds the web-search toggle on from the app default", async () => {
		stubApi({});
		mountCreate(true);
		await waitForForm();
		await vi.waitFor(() =>
			expect(switchControl("project-default-websearch").getAttribute("aria-checked")).toBe("true")
		);
	});

	it("create form seeds the web-search toggle off from the app default", async () => {
		stubApi({});
		mountCreate(false);
		await waitForForm();
		await vi.waitFor(() =>
			expect(switchControl("project-default-websearch").getAttribute("aria-checked")).toBe("false")
		);
	});

	it("edit form seeds from stored explicit values (parity with create)", async () => {
		const stored = projectView({ defaultWebSearch: false, defaultMcpConnectorIds: ["conn-a"] });
		stubApi({ project: stored, connectors: [CONN_ON(), CONN_OFF()] });
		mountDetail(true);
		await waitForDetail();
		[...document.body.querySelectorAll("button")]
			.find((button) => button.textContent?.includes("Edit"))
			?.click();

		await waitForForm();
		await vi.waitFor(() =>
			expect(switchControl("project-default-websearch").getAttribute("aria-checked")).toBe("false")
		);
		await vi.waitFor(() =>
			expect(
				document.body.querySelector('input[name="project-default-connector-conn-a"]')
			).not.toBeNull()
		);
		expect(switchControl("project-default-connector-conn-a").getAttribute("aria-checked")).toBe(
			"true"
		);
		expect(switchControl("project-default-connector-conn-b").getAttribute("aria-checked")).toBe(
			"false"
		);
	});

	it("edit form without a stored value falls back to the app default", async () => {
		const stored = projectView({});
		expect(stored.defaultWebSearch).toBeUndefined();
		stubApi({ project: stored, connectors: [CONN_ON()] });
		mountDetail(true);
		await waitForDetail();
		[...document.body.querySelectorAll("button")]
			.find((button) => button.textContent?.includes("Edit"))
			?.click();

		await waitForForm();
		await vi.waitFor(() =>
			expect(switchControl("project-default-websearch").getAttribute("aria-checked")).toBe("true")
		);
	});

	it("create saves an explicit boolean and the connector selection", async () => {
		const seen = stubApi({ connectors: [CONN_ON(), CONN_OFF()] });
		mountCreate(false);
		await waitForForm();
		await vi.waitFor(() => expect(switchControl("project-default-websearch")).not.toBeNull());
		await vi.waitFor(() =>
			expect(
				document.body.querySelector('input[name="project-default-connector-conn-a"]')
			).not.toBeNull()
		);

		const nameInput = document.body.querySelector("#project-name") as HTMLInputElement;
		nameInput.focus();
		nameInput.value = "Grant";
		nameInput.dispatchEvent(new Event("input", { bubbles: true }));

		await flipSwitch("project-default-websearch");
		await vi.waitFor(() =>
			expect(switchControl("project-default-websearch").getAttribute("aria-checked")).toBe("true")
		);
		await flipSwitch("project-default-connector-conn-a");
		await vi.waitFor(() =>
			expect(switchControl("project-default-connector-conn-a").getAttribute("aria-checked")).toBe(
				"true"
			)
		);

		[...document.body.querySelectorAll("button")]
			.find((button) => button.textContent?.includes("Create"))
			?.click();

		await vi.waitFor(() => expect(seen.some((call) => call.method === "POST")).toBe(true));
		const post = seen.find((call) => call.method === "POST");
		expect(post?.body).toMatchObject({
			name: "Grant",
			defaultWebSearch: true,
			defaultMcpConnectorIds: ["conn-a"],
		});
		expect(typeof (post?.body as { defaultWebSearch?: unknown }).defaultWebSearch).toBe("boolean");
	});

	it("edit saves an explicit boolean (change, save, re-read)", async () => {
		const stored = projectView({ defaultWebSearch: true, defaultMcpConnectorIds: ["conn-a"] });
		const seen = stubApi({ project: stored, connectors: [CONN_ON(), CONN_OFF()] });
		mountDetail(false);
		await waitForDetail();
		[...document.body.querySelectorAll("button")]
			.find((button) => button.textContent?.includes("Edit"))
			?.click();

		await waitForForm();
		await vi.waitFor(() =>
			expect(switchControl("project-default-websearch").getAttribute("aria-checked")).toBe("true")
		);

		await flipSwitch("project-default-websearch");
		await vi.waitFor(() =>
			expect(switchControl("project-default-websearch").getAttribute("aria-checked")).toBe("false")
		);
		await flipSwitch("project-default-connector-conn-a");
		await vi.waitFor(() =>
			expect(switchControl("project-default-connector-conn-a").getAttribute("aria-checked")).toBe(
				"false"
			)
		);

		[...document.body.querySelectorAll("button")]
			.find((button) => button.textContent?.trim() === "Save")
			?.click();

		await vi.waitFor(() => expect(seen.some((call) => call.method === "PATCH")).toBe(true));
		const patch = seen.find((call) => call.method === "PATCH");
		expect(patch?.body).toMatchObject({ defaultWebSearch: false, defaultMcpConnectorIds: [] });
	});

	it("detail summary matches the simplified model", async () => {
		const stored = projectView({ defaultWebSearch: true, defaultMcpConnectorIds: ["c1", "c2"] });
		stubApi({ project: stored });
		mountDetail(false);
		await waitForDetail();
		const text = document.body.textContent ?? "";
		expect(text).toContain("Web search: on");
		expect(text).toContain("MCP: 2 on");
		expect(text).not.toContain("app default");
		expect(text).not.toContain("workspace defaults");
		expect(text).not.toContain("connector on");
	});
});
