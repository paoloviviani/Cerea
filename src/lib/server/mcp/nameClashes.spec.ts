import { describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));
vi.mock("$lib/server/config", () => ({ config: { MCP_SERVERS: "" } }));
vi.mock("./tools", () => ({ resetMcpToolsCache: vi.fn() }));

import { nameClashLosers } from "./nameClashes";
import { dropDuplicateNames } from "./registry";

describe("nameClashLosers (C169)", () => {
	it("the deployment's connector beats a user's, even a newer one", () => {
		const losers = nameClashLosers([
			{ key: "connector:user", name: "Notion", deployment: false, createdAt: 1 },
			{ key: "connector:dep", name: " notion", deployment: true, createdAt: 99 },
		]);
		expect([...losers.keys()]).toEqual(["connector:user"]);
	});
	it("of two of a kind, the older wins; without a time, the lower key", () => {
		expect([
			...nameClashLosers([
				{ key: "connector:b", name: "X", deployment: false, createdAt: 5 },
				{ key: "connector:a", name: "x", deployment: false, createdAt: 9 },
			]).keys(),
		]).toEqual(["connector:a"]);
		expect([
			...nameClashLosers([
				{ key: "connector:b", name: "X", deployment: false },
				{ key: "connector:a", name: "x", deployment: false },
			]).keys(),
		]).toEqual(["connector:b"]);
	});
	it("an .env server beats an administrator's row; a computer's server loses to both", () => {
		const losers = nameClashLosers([
			{ key: "local:1", name: "notes · on laptop", deployment: false, local: true },
			{ key: "connector:u", name: "Notes · on laptop", deployment: false, createdAt: 1 },
			{ key: "connector:d", name: "search", deployment: true, createdAt: 1 },
			{ key: "base:search", name: "Search", deployment: true },
		]);
		expect([...losers.keys()].sort()).toEqual(["connector:d", "local:1"]);
	});
	it("two computers with one label: the first key wins", () => {
		const losers = nameClashLosers([
			{ key: "local:b", name: "notes · on laptop", deployment: false, local: true },
			{ key: "local:a", name: "notes · on laptop", deployment: false, local: true },
		]);
		expect([...losers.keys()]).toEqual(["local:b"]);
	});
	it("no clash, no loser", () => {
		expect(
			nameClashLosers([
				{ key: "a", name: "A", deployment: true },
				{ key: "b", name: "B", deployment: false },
			]).size
		).toBe(0);
	});
});

describe("MCP_SERVERS duplicates", () => {
	it("keeps the first of a clashing pair, drops the later ones and warns naming them", () => {
		const kept = dropDuplicateNames([
			{ name: "Search", url: "https://one.test/mcp" },
			{ name: "other", url: "https://two.test/mcp" },
			{ name: " search ", url: "https://three.test/mcp" },
		]);
		expect(kept.map((s) => s.url)).toEqual(["https://one.test/mcp", "https://two.test/mcp"]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toEqual({ kept: "Search", dropped: " search " });
		expect(warn.mock.calls[0][1]).toContain('"Search"');
	});
});
