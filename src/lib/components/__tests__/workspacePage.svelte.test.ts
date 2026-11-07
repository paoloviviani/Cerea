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

		expect(screen.getByRole("heading", { name: "Models", exact: true })).toBeInTheDocument();
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

	it("draws the On your machines section under Connectors only when LOCAL_CONNECTORS_ENABLED is on (ADR 0102)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ machines: [], data: [] }))
		);
		const off = mountWorkspace("?tab=mcp", { localConnectorsEnabled: false });
		expect(off.baseElement.textContent).not.toContain("On your machines");
		expect(off.baseElement.querySelector("#on-your-machines")).toBeNull();
		off.unmount();
		document.getElementById("app")?.remove();

		const on = mountWorkspace("?tab=mcp", { localConnectorsEnabled: true });
		await expect
			.element(on.getByRole("heading", { name: "On your machines", level: 2 }))
			.toBeInTheDocument();
		await expect
			.element(on.getByRole("heading", { name: "Connect a machine" }))
			.toBeInTheDocument();
		// Under the connectors, in the same tab, addressable.
		const connectors = on.getByRole("heading", { name: "Connectors", exact: true }).element();
		const machines = on.baseElement.querySelector("#on-your-machines") as HTMLElement;
		expect(
			connectors.compareDocumentPosition(machines) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it("the old ?tab=local and ?tab=custom addresses land on Models when they reach the panel", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		for (const tab of ["local", "custom"]) {
			const screen = mountWorkspace(`?tab=${tab}`, { localConnectorsEnabled: true });
			expect(screen.getByRole("heading", { name: "Models", exact: true })).toBeInTheDocument();
			screen.unmount();
			document.getElementById("app")?.remove();
		}
	});

	it("offers the Agents tab (the user's own auto-approval, ADR 0109) only for a signed-in user where coding agents exist", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					settings: {
						enabled: false,
						decisionModelId: null,
						threshold: 0.85,
						instructions: "",
						perClass: {},
					},
					deploymentEnabled: true,
					killSwitchOn: false,
					decisionModels: [],
					catalogue: "ok",
				})
			)
		);
		const off = mountWorkspace("?tab=agents", { user: { id: "u" }, codeAgentsEnabled: false });
		expect(off.baseElement.textContent).not.toContain("Auto-approval");
		expect(off.getByRole("heading", { name: "Models", exact: true })).toBeInTheDocument();
		off.unmount();
		document.getElementById("app")?.remove();

		const on = mountWorkspace("?tab=agents", { user: { id: "u" }, codeAgentsEnabled: true });
		expect(on.baseElement.querySelector('nav a[href$="/workspace?tab=agents"]')).not.toBeNull();
		await expect.element(on.getByRole("heading", { name: "Auto-approval" })).toBeInTheDocument();
	});

	it("a mistyped tab param falls back to Models", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		const screen = mountWorkspace("?tab=nonsense");
		expect(screen.getByRole("heading", { name: "Models", exact: true })).toBeInTheDocument();
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
	});

	it("renders Your custom models as a section of the Models tab, not a tab of its own", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		const screen = mountWorkspace("?tab=models");

		await expect
			.element(screen.getByRole("heading", { name: "Your custom models", level: 2 }))
			.toBeInTheDocument();
		expect(screen.baseElement.textContent).toContain("Instructions for every chat");
		expect(screen.baseElement.querySelector("#custom-models")).not.toBeNull();
		expect(screen.baseElement.querySelector('a[href="/workspace?tab=custom"]')).toBeNull();
	});

	it("has six tabs at most: Models, Memory, Knowledge, Skills, Connectors and Agents", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		const screen = mountWorkspace("", {
			user: { id: "u" },
			codeAgentsEnabled: true,
			localConnectorsEnabled: true,
		});
		const hrefs = [...screen.baseElement.querySelectorAll("nav[aria-label] a")].map((a) =>
			a.getAttribute("href")
		);
		expect(hrefs).toEqual([
			"/workspace?tab=models",
			"/workspace?tab=memory",
			"/workspace?tab=kb",
			"/workspace?tab=skills",
			"/workspace?tab=mcp",
			"/workspace?tab=agents",
		]);
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
