/**
 * The admin MCP page lists the servers `.env` defines (`MCP_SERVERS`) beside the connectors an
 * administrator adds here: read-only, marked "Set in the .env file", with no Remove.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { page } from "@vitest/browser/context";

import Page from "./+page.svelte";
import { allMcpServers } from "$lib/stores/mcpServers";
import type { MCPServer } from "$lib/types/Tool";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const env = (name: string, extra: Partial<MCPServer> = {}): MCPServer => ({
	id: `base-${name}`,
	name,
	url: `https://${name}.test/mcp`,
	type: "base",
	...extra,
});

describe("admin MCP page", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: [
						{
							id: "c-gui",
							name: "Notion",
							url: "https://notion.test/mcp",
							auth: "oauth",
							scope: "deployment",
							manageable: true,
							connected: false,
							canAuthorize: true,
							updatedAt: new Date().toISOString(),
						},
					],
				})
			)
		);
	});

	it("lists .env servers read-only next to the deployment connectors", async () => {
		allMcpServers.set([
			env("search", { status: "connected", tools: [{ name: "a" }, { name: "b" }] }),
			env("osm"),
		]);
		const screen = renderWithApp(Page, {} as never);

		await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
		const rows = [...screen.baseElement.querySelectorAll('[data-testid="env-server"]')];
		expect(rows.map((r) => r.querySelector("p")?.textContent)).toEqual(["osm", "search"]);
		expect(rows[1].textContent).toContain("Set in the .env file");
		expect(rows[1].textContent).toContain("reachable · 2 tools");
		expect(rows[0].textContent).toContain("not checked");
		// Read-only: the only Remove on the page is the GUI connector's.
		const removes = [...screen.baseElement.querySelectorAll("button")].filter((b) =>
			b.textContent?.includes("Remove")
		);
		expect(removes).toHaveLength(1);
		expect(rows.some((r) => r.textContent?.includes("Remove"))).toBe(false);
		expect(screen.baseElement.textContent).toContain("edit them there");
	});
});
