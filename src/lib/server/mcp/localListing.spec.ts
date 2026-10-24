/**
 * A local server that is slow to start (an `npx` cold start) and speaks the 2026 era: its
 * first process misses the era probe, so the client settles on the 2025 handshake, under which
 * this server lists no tools. That used to be cached as a success, the era was remembered
 * as legacy, and the shared connection lived on, so the connector's tools never reached the
 * model and nothing said so until the chat restarted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ChildLocalTransport,
	SLOW_MODERN_SERVER,
	machine,
	resetMachine,
} from "./testing/childLocalTransport";

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));
const env = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock("$lib/server/logger", () => ({ logger: log }));
vi.mock("./elicitationConfig", () => ({
	isElicitationEnabled: () => true,
	getElicitationTimeoutMs: () => 30_000,
}));
vi.mock("./local", () => ({ localServerFingerprint: () => "entry" }));
vi.mock("./localTransport", () => ({
	createLocalTransport: async () => new ChildLocalTransport(SLOW_MODERN_SERVER, env.value),
}));
// A probe shorter than the server's cold start, without making every test wait ten seconds.
vi.mock("./localEra", async (importOriginal) => ({
	...(await importOriginal<typeof import("./localEra")>()),
	LOCAL_PROBE_TIMEOUT_MS: 800,
}));

const { getClient, drainPool } = await import("./clientPool");
const { getOpenAiToolsForMcp, resetMcpToolsCache } = await import("./tools");
const { callMcpTool } = await import("./httpClient");
const { localServerUrl } = await import("./localUrl");
const { knownLocalEra, rememberLocalEra, resetLocalEras } = await import("./localEra");

const server = {
	name: "calendar · on laptop",
	url: localServerUrl(new ObjectId().toString(), new ObjectId().toString(), "calendar"),
};

let dir: string;
const coldStart = (extra: Record<string, string> = {}) => {
	env.value = { SLOW_MS: "1800", SLOW_MARKER: join(dir, "started"), ...extra };
};

describe("a local server that is slow to start", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lchard-"));
		resetMachine();
		resetLocalEras();
		resetMcpToolsCache();
		for (const fn of Object.values(log)) fn.mockClear();
	});
	afterEach(async () => {
		await drainPool();
		rmSync(dir, { recursive: true, force: true });
	});

	it("does not remember an era until a listing has been answered on the connection", async () => {
		coldStart();
		const client = await getClient(server);
		// Connected (the probe was missed, so legacy), but nothing has proven that yet.
		expect(client.getProtocolEra()).toBe("legacy");
		expect(knownLocalEra(server.url, "entry")).toBeUndefined();
		// This server lists nothing to a legacy caller: still not proof of anything.
		await client.listTools();
		expect(knownLocalEra(server.url, "entry")).toBeUndefined();
	}, 20_000);

	it("remembers the era once a listing has succeeded", async () => {
		env.value = {};
		const client = await getClient(server);
		expect(knownLocalEra(server.url, "entry")).toBeUndefined();
		await client.listTools();
		expect(knownLocalEra(server.url, "entry")).toBe("modern");
	}, 20_000);

	it("warns, retries on a fresh connection and ends with the tools", async () => {
		coldStart();
		const result = await getOpenAiToolsForMcp([server]);
		expect(result.tools.map((t) => t.function.name)).toEqual(["echo", "boom"]);
		expect(result.unavailable).toEqual([]);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn.mock.calls[0][1]).toBe("[mcp] local server listed no tools");
		expect(log.warn.mock.calls[0][0]).toMatchObject({ server: server.name });
		// A second process, started after the first was dropped.
		expect(machine.opens).toBe(2);
		expect(knownLocalEra(server.url, "entry")).toBe("modern");
		// The good listing is the one cached.
		await getOpenAiToolsForMcp([server]);
		expect(machine.opens).toBe(2);
	}, 30_000);

	for (const [emptyMode, reason] of [
		["always", "the connector started but listed no tools"],
		// The SDK itself refuses a result without `tools`: a failure that is thrown, not empty.
		["missing", "the server could not be reached or did not answer as an MCP server"],
	]) {
		it(`reports the server unavailable when it keeps listing nothing (${emptyMode}), and caches nothing`, async () => {
			env.value = { EMPTY_MODE: emptyMode };
			rememberLocalEra(server.url, "legacy", "entry");
			const first = await getOpenAiToolsForMcp([server]);
			expect(first.tools).toEqual([]);
			expect(first.unavailable).toEqual([{ name: server.name, reason }]);
			if (emptyMode === "always") {
				expect(log.warn.mock.calls.map((c) => c[1])).toContain(
					"[mcp] local server listed no tools"
				);
			}
			// The stale era went with the connection.
			expect(knownLocalEra(server.url, "entry")).toBeUndefined();
			// Not cached: the next turn lists again.
			const opens = machine.opens;
			await getOpenAiToolsForMcp([server]);
			expect(machine.opens).toBeGreaterThan(opens);
		}, 30_000);
	}

	it("forgets the era of a pooled client whose call failed", async () => {
		env.value = {};
		const client = await getClient(server);
		await client.listTools();
		expect(knownLocalEra(server.url, "entry")).toBe("modern");
		await expect(callMcpTool(server, "boom", {})).rejects.toThrow();
		expect(knownLocalEra(server.url, "entry")).toBeUndefined();
	}, 20_000);
});
