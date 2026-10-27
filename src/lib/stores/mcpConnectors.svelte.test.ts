/**
 * The connectors store (ADR 0064, ADR 0104): the list, one switch per connector kept on the
 * server, and no selection of the browser's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import {
	connectors,
	enabledConnectorsCount,
	refreshConnectors,
	setConnectorEnabled,
} from "./mcpConnectors";
import { allMcpServers, forgetOldMcpSelections } from "./mcpServers";
import type { McpConnectorView } from "$lib/types/McpConnector";
import type { MCPServer } from "$lib/types/Tool";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const view = (id: string, extra: Partial<McpConnectorView> = {}): McpConnectorView => ({
	id,
	key: `connector:${id}`,
	enabled: true,
	name: `Server ${id}`,
	url: `https://${id}.test/mcp`,
	auth: "none",
	scope: "user",
	manageable: true,
	connected: true,
	canAuthorize: false,
	updatedAt: new Date().toISOString(),
	...extra,
});
const env = (name: string, extra: Partial<MCPServer> = {}): MCPServer => ({
	id: `base-${name}`,
	key: `base:${name}`,
	name,
	url: `https://${name}.test/mcp`,
	type: "base",
	mode: "on",
	enabled: true,
	...extra,
});

let calls: Array<{ method: string; url: string; body: unknown }>;
function stub(respond: (url: string, method: string) => Response) {
	calls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			const method = init?.method ?? "GET";
			calls.push({ method, url: href, body: init?.body ? JSON.parse(String(init.body)) : null });
			return respond(href, method);
		})
	);
}

beforeEach(() => {
	connectors.set([]);
	allMcpServers.set([]);
	localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("setConnectorEnabled", () => {
	it("shows the switch at once and asks the server to keep it", async () => {
		connectors.set([view("a")]);
		allMcpServers.set([env("search")]);
		stub(() => Response.json({}));

		await setConnectorEnabled("connector:a", false);
		await setConnectorEnabled("base:search", false);

		expect(get(connectors)[0].enabled).toBe(false);
		expect(get(allMcpServers)[0].enabled).toBe(false);
		expect(calls.map((c) => c.body)).toEqual([
			{ key: "connector:a", enabled: false },
			{ key: "base:search", enabled: false },
		]);
	});

	it("puts the switch back when the server refuses (a connector kept on by the administrator)", async () => {
		connectors.set([view("a")]);
		stub(() => Response.json({ message: "kept on" }, { status: 409 }));

		await expect(setConnectorEnabled("connector:a", false)).rejects.toThrow("kept on");

		expect(get(connectors)[0].enabled).toBe(true);
	});
});

describe("what is counted as on", () => {
	it("counts what this person has on and can use, the administrator's locked ones included", () => {
		allMcpServers.set([env("search", { mode: "locked" }), env("osm", { enabled: false })]);
		connectors.set([view("a"), view("b", { enabled: false }), view("c", { connected: false })]);
		// search (locked, on) + a. Not osm (switched off), b (switched off), c (not signed in).
		expect(get(enabledConnectorsCount)).toBe(2);
	});
});

describe("refreshConnectors", () => {
	it("loads the list the server gives, with each connector's own state", async () => {
		stub(() => Response.json({ data: [view("a", { enabled: false })] }));
		await refreshConnectors();
		expect(get(connectors).map((c) => [c.id, c.enabled])).toEqual([["a", false]]);
	});
});

describe("what older builds left in this browser", () => {
	it("is forgotten, not read: no stale choice can look like a switch", () => {
		const stale = [
			"chatui:mcp:selected-ids",
			"chatui:mcp:disabled-base-ids",
			"pystino:mcp:default-connector-ids",
			"pystino:mcp:selected-connector-ids",
			"pystino:mcp:conversation-connector-ids:abc",
		];
		for (const key of stale) localStorage.setItem(key, JSON.stringify(["x"]));
		localStorage.setItem("something:else", "kept");

		forgetOldMcpSelections();

		for (const key of stale) expect(localStorage.getItem(key), key).toBeNull();
		expect(localStorage.getItem("something:else")).toBe("kept");
	});
});
