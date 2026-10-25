/**
 * The connectors screen in the `en-XA` pseudo-locale: every word on it comes
 * from the catalogue, so none can be left behind by a translation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MCPServerManager from "./MCPServerManager.svelte";
import type { McpConnectorView } from "$lib/types/McpConnector";
import { connectors } from "$lib/stores/mcpConnectors";
import { allMcpServers } from "$lib/stores/mcpServers";
import { m } from "$lib/paraglide/messages";
import { renderWithApp } from "../__tests__/renderWithApp";
import { unbracketedWords, useEnglish, usePseudoLocale } from "../__tests__/enXaManage";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const base = {
	url: "https://one.test/mcp",
	auth: "oauth" as const,
	manageable: true,
	connected: false,
	canAuthorize: true,
	updatedAt: new Date().toISOString(),
};
const LIST: McpConnectorView[] = [
	{ ...base, id: "c1", name: "Mine", scope: "user" },
	{ ...base, id: "c2", name: "Shared", scope: "deployment", manageable: false },
	{ ...base, id: "c3", name: "Linked", scope: "user", auth: "token", connected: true },
];

describe("Connectors, in the pseudo-locale", () => {
	beforeEach(() => {
		connectors.set([]);
		allMcpServers.set([]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
				String(input).includes("/api/v2/mcp/connectors") && (init?.method ?? "GET") === "GET"
					? Response.json({ data: LIST })
					: Response.json({})
			)
		);
		usePseudoLocale();
	});
	afterEach(() => {
		useEnglish();
		vi.unstubAllGlobals();
	});

	it("renders every word from the catalogue", async () => {
		const screen = renderWithApp(MCPServerManager);
		const heading = m["mcp.connectors.yours"]({ count: 2 }, { locale: "en-XA" });
		expect(heading).toMatch(/^\[.+\]$/);
		await expect.element(screen.getByText(heading)).toBeVisible();

		// Names and addresses are data, not words of ours.
		expect(unbracketedWords([/^(Mine|Shared|Linked)$/, /^https?:/])).toEqual([]);
	});
});
