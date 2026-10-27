/**
 * The `.env` servers store (ADR 0104): a list the server provides, with no
 * selection of the browser's own.
 *
 * The test environment runs in Node (browser === false), so the module-level
 * refresh does not run and no real fetch is attempted during import.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import type { MCPServer } from "$lib/types/Tool";

import * as store from "./mcpServers";
import { allMcpServers, mcpServersLoaded, initWithServers } from "./mcpServers";

function makeServer(name: string, extra: Partial<MCPServer> = {}): MCPServer {
	return {
		id: `base-${name}`,
		key: `base:${name}`,
		name,
		url: `https://mcp.example.com/${name}`,
		type: "base",
		mode: "on",
		enabled: true,
		isLocked: false,
		status: undefined,
		...extra,
	};
}

beforeEach(() => {
	allMcpServers.set([]);
	mcpServersLoaded.set(false);
});

describe("initWithServers", () => {
	it("marks the list loaded, even when it is empty", () => {
		expect(get(mcpServersLoaded)).toBe(false);
		initWithServers([]);
		expect(get(mcpServersLoaded)).toBe(true);
		expect(get(allMcpServers)).toEqual([]);
	});

	it("keeps what the server said about each one: its mode and whether this person has it on", () => {
		const servers = [
			makeServer("search", { mode: "locked" }),
			makeServer("files", { enabled: false }),
		];
		initWithServers(servers);
		expect(get(allMcpServers)).toEqual(servers);
	});

	it("is idempotent: a second call with new data wins cleanly", () => {
		initWithServers([makeServer("search")]);
		initWithServers([makeServer("files"), makeServer("code")]);
		expect(get(allMcpServers).map((s) => s.name)).toEqual(["files", "code"]);
	});
});

describe("no selection of the browser's own", () => {
	it("exports nothing that chooses servers for a turn", () => {
		// What older builds exported; the server decides what a turn uses now, so a stale
		// choice kept here could only mislead.
		for (const removed of [
			"selectedServerIds",
			"enabledServers",
			"toggleServer",
			"disableAllServers",
			"applyProjectServerDefaults",
		]) {
			expect(store, removed).not.toHaveProperty(removed);
		}
	});
});
