/**
 * Loading a connector's tools, and why it can fail (ADR 0104).
 */
import { describe, expect, it, vi } from "vitest";
import { createConnectorRuntime } from "./connectorRuntime";
import { connectorCatalogNotice, createLoadToolsBuiltin } from "../builtinTools/loadToolsTool";
import {
	hostOf,
	summaryOf,
	type BlockedConnector,
	type TurnConnector,
} from "$lib/server/mcp/turnConnectors";

vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const connector = (name: string, extra: Partial<TurnConnector> = {}): TurnConnector => ({
	key: `base:${name}`,
	name,
	kind: "base",
	alwaysLoaded: false,
	summary: `${name} things.`,
	toolNames: [`${name}_find`],
	open: async () => ({ server: { name, url: `https://${name}.test/mcp` } }),
	...extra,
});

function setup(
	connectors: TurnConnector[],
	blocked: BlockedConnector[] = [],
	failing: string[] = []
) {
	const servers: Array<{ name: string; url: string }> = [];
	const mapping: Record<string, { fnName: string; server: string; tool: string }> = {};
	const tools: Array<{ type: "function"; function: { name: string } }> = [];
	const persisted: string[][] = [];
	const runtime = createConnectorRuntime({
		connectors,
		blocked,
		loadedKeys: [],
		servers,
		mapping,
		tools,
		mcpTools: [],
		builtinNames: new Set(["web_search"]),
		prepare: (list) => list,
		list: async (list) => {
			const t = list.map((s) => ({
				type: "function" as const,
				function: { name: `${s.name}_find` },
			}));
			return {
				tools: t,
				mapping: Object.fromEntries(
					list.map((s) => [
						`${s.name}_find`,
						{ fnName: `${s.name}_find`, server: s.name, tool: "find" },
					])
				),
				unavailable: list
					.filter((s) => failing.includes(s.name))
					.map((s) => ({ name: s.name, reason: "refused" })),
			};
		},
		repair: (list) => list,
		persist: async (keys) => void persisted.push(keys),
	});
	return { runtime, servers, mapping, tools, persisted };
}

describe("load_tools", () => {
	it("loads a connector by name, appends its tools, and records it", async () => {
		const { runtime, tools, persisted } = setup([connector("maps"), connector("osm")]);
		const reports = await runtime.load(["Maps"]);
		expect(reports).toEqual([{ name: "maps", status: "loaded", tools: ["maps_find"] }]);
		await runtime.load(["osm"]);
		expect(tools.map((t) => t.function.name)).toEqual(["maps_find", "osm_find"]);
		expect(persisted).toEqual([["base:maps"], ["base:osm"]]);
		expect(runtime.version).toBe(2);
	});

	it("says why a connector cannot be loaded", async () => {
		const { runtime, tools } = setup(
			[connector("maps"), connector("down")],
			[
				{ key: "base:mine", name: "mine", reason: "switched off" },
				{ key: "connector:1", name: "Notion", reason: "needs sign-in" },
			],
			["down"]
		);
		const reports = await runtime.load(["maps", "maps", "nothing", "mine", "notion", "down"]);
		expect(reports.map((r) => r.status)).toEqual([
			"loaded",
			"already",
			"unknown",
			"switched off",
			"needs sign-in",
			"unavailable",
		]);
		// Only the one that loaded added tools.
		expect(tools.map((t) => t.function.name)).toEqual(["maps_find"]);
	});

	it("loads a name that matches more than one connector only when one is meant (review L4)", async () => {
		const { runtime, tools } = setup([connector("github"), connector("gitlab")]);
		const reports = await runtime.load(["git"]);
		expect(reports).toEqual([
			{ name: "git", status: "ambiguous", candidates: ["github", "gitlab"] },
		]);
		expect(tools).toEqual([]);
		// The exact name is not ambiguous.
		expect((await runtime.load(["GitHub"]))[0].status).toBe("loaded");
		const tool = createLoadToolsBuiltin(setup([connector("github"), connector("gitlab")]).runtime);
		const said = await tool.execute({ connectors: ["git"] }, { uuid: "u", toolCallId: "t" });
		expect(said).toEqual({ resultText: expect.stringContaining("ambiguous") });
		expect(JSON.stringify(said)).toContain("github, gitlab");
	});

	it("does not guess which connector a tool two of them offer belongs to (review L4)", async () => {
		const { runtime, tools } = setup([
			connector("github", { toolNames: ["create_issue"] }),
			connector("gitlab", { toolNames: ["create_issue"] }),
		]);
		expect(await runtime.loadForCalls(["create_issue"])).toEqual([
			{ name: "create_issue", status: "ambiguous", candidates: ["github", "gitlab"] },
		]);
		expect(tools).toEqual([]);
	});

	it("answers the model in words, never with a credential", async () => {
		const { runtime } = setup([connector("maps")]);
		const tool = createLoadToolsBuiltin(runtime);
		const ok = await tool.execute({ connectors: ["maps"] }, { uuid: "u", toolCallId: "t" });
		expect(ok).toEqual({ resultText: expect.stringContaining("Loaded maps") });
		expect(await tool.execute({ connectors: [] }, { uuid: "u", toolCallId: "t" })).toHaveProperty(
			"error"
		);
	});

	it("loads the owner of a tool the model called without loading it", async () => {
		const { runtime, mapping } = setup([connector("maps")]);
		expect(await runtime.loadForCalls(["web_search", "maps_find"])).toHaveLength(1);
		expect(mapping.maps_find).toBeDefined();
		// Nothing owns this one: nothing is loaded for it.
		expect(await runtime.loadForCalls(["made_up"])).toEqual([]);
	});
});

describe("the list of connectors the assistant can load", () => {
	it("has one line each, skips always loaded ones, and does not change when one is loaded", () => {
		const list = [
			connector("maps", { toolNames: ["route", "geocode"] }),
			connector("search", { alwaysLoaded: true }),
		];
		const text = connectorCatalogNotice(list);
		expect(text).toContain("- maps: maps things. Tools: route, geocode.");
		expect(text).not.toContain("- search:");
		expect(connectorCatalogNotice([])).toBe("");
	});

	it("names the host of a connector whose tools are not known, and says so, the same way every turn", () => {
		const unknown = connector("Find locations", {
			summary: summaryOf(undefined, []),
			toolNames: [],
			host: "api.geoapify.com",
		});
		const text = connectorCatalogNotice([unknown, connector("maps", { host: "maps.test" })]);
		expect(text).toContain(
			"- Find locations (api.geoapify.com): its tools haven't been checked; load it to see them."
		);
		// With tool names the line is as it was: the host adds nothing there.
		expect(text).toContain("- maps: maps things. Tools: maps_find.");
		// Stable across turns: built again from the same row, it is the same text.
		expect(connectorCatalogNotice([unknown, connector("maps", { host: "maps.test" })])).toBe(text);
	});

	it("takes the host from the address, and none from one that does not parse", () => {
		expect(hostOf("https://api.geoapify.com/v1/mcp?apiKey=x")).toBe("api.geoapify.com");
		expect(hostOf("not an address")).toBeUndefined();
	});
});
