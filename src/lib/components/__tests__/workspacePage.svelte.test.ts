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
					customPrompts: {},
					customPromptsEnabled: {},
					multimodalOverrides: {},
					toolsOverrides: {},
					artifactsOverrides: {},
					reasoningOverrides: {},
				}),
			],
		]),
	};
}

function mountWorkspace(query: string) {
	let host = document.getElementById("app");
	if (!host) {
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	}
	return renderWithApp(
		WorkspacePanel,
		{
			data: { models: [MODEL], mlAssistantModels: [] },
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
		expect(screen.baseElement.textContent).not.toContain("Manage MCP servers to extend");
		expect(screen.baseElement.textContent).not.toContain("Documents an assistant can search");
	});

	it("renders the MCP and Knowledge managers on their tab param", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		const mcp = mountWorkspace("?tab=mcp");
		expect(mcp.getByRole("heading", { name: "MCP Servers" })).toBeInTheDocument();
		mcp.unmount();
		document.getElementById("app")?.remove();

		const kb = mountWorkspace("?tab=kb");
		expect(kb.getByRole("heading", { name: "Knowledge bases" })).toBeInTheDocument();
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

		// The detail view, not the list: the model's own settings.
		await expect
			.element(screen.getByRole("heading", { name: "System prompt" }))
			.toBeInTheDocument();
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
});
