/**
 * The workspace panel: the three managers as tabs of one page.
 *
 * The tab and the item are the address — `?tab=models|mcp|kb`, an `?id=`
 * opening one item's own view — so these checks pin what each address renders
 * and that the tab bar offers the three addresses. The managers themselves
 * have their own cover; here it is the addressing that is under test.
 */
import WorkspacePanel from "$lib/components/workspace/WorkspacePanel.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { connectors } from "$lib/stores/mcpConnectors";

// The client setup mocks `$app/*` but not `$env/dynamic/*`: the MCP store the
// tab's manager reads pulls a deployment name off the environment at module
// scope, and the bare name is all a test needs.
vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const MODEL = {
	id: "test/model",
	displayName: "Test Model",
	description: "A model for tests",
};

/** The slice of the layout's settings context ModelsManager reads and writes. */
function settingsContext() {
	return {
		context: new Map<unknown, unknown>([
			[
				"settings",
				writable({
					activeModel: "test/model",
					multimodalOverrides: {},
					toolsOverrides: {},
					artifactsOverrides: {},
					reasoningOverrides: {},
				}),
			],
		]),
	};
}

function mountWorkspace(query: string, extra: Record<string, unknown> = {}) {
	let host = document.getElementById("app");
	if (!host) {
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	}
	return renderWithApp(
		WorkspacePanel,
		{
			data: { models: [MODEL], ...extra },
		} as never,
		{
			page: { url: `http://localhost:3000/workspace${query}` },
			baseElement: host,
			...settingsContext(),
		}
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.getElementById("app")?.remove();
});

describe("the workspace panel", () => {
	it("defaults to the Models tab on a bare /workspace", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		const screen = mountWorkspace("");

		expect(screen.getByRole("heading", { name: "Models" })).toBeInTheDocument();
		expect(screen.baseElement.textContent).toContain("Every model available to you.");
		// The other two managers are not mounted beside it.
		expect(screen.baseElement.textContent).not.toContain(
			"Connect Cerea to other apps and services"
		);
		expect(screen.baseElement.textContent).not.toContain("Documents an assistant can search");
	});

	it("renders the MCP and Knowledge managers on their tab param", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		const mcp = mountWorkspace("?tab=mcp");
		expect(mcp.getByRole("heading", { name: "Connectors", exact: true })).toBeInTheDocument();
		mcp.unmount();
		document.getElementById("app")?.remove();

		const kb = mountWorkspace("?tab=kb");
		expect(kb.getByRole("heading", { name: "Knowledge bases" })).toBeInTheDocument();
	});

	it("offers the Local connectors tab only when LOCAL_CONNECTORS_ENABLED is on (ADR 0102)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ machines: [], data: [] }))
		);
		const off = mountWorkspace("?tab=local", { localConnectorsEnabled: false });
		expect(off.baseElement.textContent).not.toContain("Local connectors");
		// A hidden tab's address lands on Models, like Knowledge with its pipeline off.
		expect(off.getByRole("heading", { name: "Models" })).toBeInTheDocument();
		off.unmount();
		document.getElementById("app")?.remove();

		const on = mountWorkspace("?tab=local", { localConnectorsEnabled: true });
		await expect.element(on.getByRole("link", { name: "Local connectors" })).toBeInTheDocument();
		await expect
			.element(on.getByRole("heading", { name: "Connect a machine" }))
			.toBeInTheDocument();
	});

	it("a mistyped tab param falls back to Models", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		const screen = mountWorkspace("?tab=nonsense");
		expect(screen.getByRole("heading", { name: "Models" })).toBeInTheDocument();
	});

	it("an ?id= opens the manager straight onto that item", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		const screen = mountWorkspace("?tab=models&id=test/model");

		// The detail view, not the list: the model's own settings. (The per-model
		// system prompt that used to head it is gone.)
		await expect
			.element(screen.getByRole("heading", { name: "What it may do" }))
			.toBeInTheDocument();
		expect(screen.baseElement.textContent).not.toContain("Instructions");
	});

	it("renders Custom models on ?tab=custom, and links it from the tab bar", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		const screen = mountWorkspace("?tab=custom");

		await expect
			.element(screen.getByRole("heading", { name: "Custom models", level: 2 }))
			.toBeInTheDocument();
		expect(screen.baseElement.textContent).toContain("Instructions for every chat");
		expect(screen.baseElement.querySelector('a[href="/workspace?tab=custom"]')).not.toBeNull();
		expect(
			screen.baseElement.querySelector('a[href="/workspace?tab=custom"][aria-current="page"]')
		).not.toBeNull();
	});

	it("the tab bar links the three addresses, marking the active one", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		const screen = mountWorkspace("?tab=mcp");

		expect(screen.baseElement.querySelector('a[href="/workspace?tab=models"]')).not.toBeNull();
		expect(screen.baseElement.querySelector('a[href="/workspace?tab=mcp"]')).not.toBeNull();
		expect(screen.baseElement.querySelector('a[href="/workspace?tab=kb"]')).not.toBeNull();
		expect(
			screen.baseElement.querySelector('a[href="/workspace?tab=mcp"][aria-current="page"]')
		).not.toBeNull();
		expect(
			screen.baseElement.querySelector('a[href="/workspace?tab=models"][aria-current]')
		).toBeNull();
	});

	it("the MCP tab labels the per-connector switch", async () => {
		// The connectors store is module state shared with the cases above,
		// which all stub an empty list: serve one connected connector here so
		// its card (and label) renders, then put the empty list back.
		connectors.set([]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/api/v2/mcp/connectors")) {
					return Response.json({
						data: [
							{
								id: "conn-a",
								key: "connector:conn-a",
								enabled: true,
								name: "Notion",
								url: "https://mcp.notion.com/mcp",
								auth: "none",
								scope: "user",
								manageable: false,
								connected: true,
								canAuthorize: false,
								updatedAt: new Date().toISOString(),
							},
						],
					});
				}
				if (url.includes("/api/mcp/servers")) return Response.json([]);
				return Response.json({ data: [] });
			})
		);
		const screen = mountWorkspace("?tab=mcp");

		await expect.element(screen.getByText("Use in my chats", { exact: true })).toBeInTheDocument();
		screen.unmount();
		document.getElementById("app")?.remove();
		connectors.set([]);
	});
});
