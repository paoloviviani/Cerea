/**
 * The catalogue cache of `.env` servers' tool names (ADR 0104): fed only by the deployment's
 * own refresh, never by a listing a turn makes with somebody's credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listing = vi.hoisted(() => ({
	tools: [{ name: "find", description: "Find things.", inputSchema: { type: "object" } }] as Array<
		Record<string, unknown>
	>,
}));
const pool = vi.hoisted(() => ({
	seen: [] as Array<{ url: string; headers?: Record<string, string> }>,
	gate: undefined as Promise<void> | undefined,
}));
vi.mock("./clientPool", () => ({
	getClient: async (server: { url: string; headers?: Record<string, string> }) => {
		pool.seen.push({ url: server.url, headers: server.headers });
		return {
			listTools: async () => {
				await pool.gate;
				return { tools: listing.tools };
			},
		};
	},
	retainClient: () => {},
	releaseClient: () => {},
	forgetLocalConnection: () => {},
}));
vi.mock("$lib/server/config", () => ({
	config: { EXA_API_KEY: "deployment-exa-key", MCP_FORWARD_HF_USER_TOKEN: "true" },
}));

const { getOpenAiToolsForMcp, resetMcpToolsCache } = await import("./tools");
const { knownTools, refreshCatalog, resetCatalogCache } = await import("./catalogCache");

beforeEach(() => {
	pool.seen = [];
	pool.gate = undefined;
	resetMcpToolsCache();
	resetCatalogCache();
});
afterEach(() => vi.restoreAllMocks());

describe("the catalogue cache", () => {
	it("does not record a listing a turn makes, with whoever's credential it carries", async () => {
		const url = "https://huggingface.co/mcp?login";
		await getOpenAiToolsForMcp([
			{ name: "hf", url, headers: { Authorization: "Bearer one-persons-token" } },
		]);
		expect(pool.seen).toHaveLength(1);
		expect(knownTools(url)).toBeUndefined();
	});

	it("is filled by the refresh, which lists as a turn would call it but with no person's token", async () => {
		const exa = "https://mcp.exa.ai/mcp";
		const hf = "https://huggingface.co/mcp?login";
		await refreshCatalog([
			{ name: "exa", url: exa },
			{ name: "hf", url: hf },
		]);
		// The deployment's own overlay (the Exa key) is applied, as on the turn path.
		expect(pool.seen.find((s) => s.url.startsWith(exa))?.url).toContain(
			"exaApiKey=deployment-exa-key"
		);
		// Nobody's token: the HF server is listed without one.
		expect(pool.seen.find((s) => s.url === hf)?.headers?.Authorization).toBeUndefined();
		// Recorded under the configured address, which is what a turn looks up.
		expect(knownTools(exa)?.map((t) => t.name)).toEqual(["find"]);
		expect(knownTools(hf)?.map((t) => t.name)).toEqual(["find"]);
	});

	it("records a tool's own description in the catalogue, never the guard sentence", async () => {
		const url = "https://mcp.exa.ai/mcp";
		listing.tools = [{ name: "bare", inputSchema: { type: "object" } }];
		await refreshCatalog([{ name: "exa", url }]);
		expect(knownTools(url)?.[0].description).toBeUndefined();
		listing.tools = [
			{ name: "find", description: "Find things.", inputSchema: { type: "object" } },
		];
	});

	it("does not start a refresh while one is still running", async () => {
		let release = () => {};
		pool.gate = new Promise<void>((resolve) => (release = resolve));
		const first = refreshCatalog([{ name: "search", url: "https://search.test/mcp" }]);
		await refreshCatalog([{ name: "search", url: "https://search.test/mcp" }]);
		release();
		await first;
		expect(pool.seen).toHaveLength(1);
	});
});
