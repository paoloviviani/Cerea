/**
 * `browser.key` is granted to a connectors-only machine (no agent, no `code_agents`), and only to
 * a paired machine that serves local connectors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const state = vi.hoisted(() => ({
	browser: "true",
	device: null as Record<string, unknown> | null,
	agentsEnabled: false,
}));

vi.mock("$lib/server/config", () => ({
	config: {
		get CHAT_BROWSER_ENABLED() {
			return state.browser;
		},
	},
}));
vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("$lib/server/codeEnabled", () => ({
	localConnectorsEnabled: () => true,
	// Deliberately present and off: the browser key must not ask for it.
	codeAgentsEnabled: () => state.agentsEnabled,
}));
vi.mock("$lib/server/mcp/secretBox", () => ({ sealingAvailable: () => true }));
vi.mock("$lib/server/database", () => ({
	collections: { codeDevices: { findOne: async () => state.device } },
}));
vi.mock("./grants", () => ({ deviceBrowserKey: async () => Buffer.alloc(32, 7) }));

const { handleBrowserCall } = await import("./keyCall");

const id = new ObjectId();
const frame = { type: "call", id: "1", op: "browser.key", args: {} } as never;

function setDevice(over: Record<string, unknown>) {
	state.device = { _id: id, userId: new ObjectId(), status: "paired", ...over };
}

beforeEach(() => {
	state.browser = "true";
	state.agentsEnabled = false;
});

describe("browser.key", () => {
	it("is granted to a connectors-only machine, with agents off", async () => {
		setDevice({ machine: { mode: "connectors", capabilities: { mcp: true } } });
		const res = await handleBrowserCall(id.toString(), frame);
		expect(res).toMatchObject({ ok: true, result: { alg: "HMAC-SHA256" } });
	});

	it("is granted to an agent machine that has an mcp.json", async () => {
		setDevice({ machine: { mode: "agent", capabilities: { mcp: true } } });
		expect(await handleBrowserCall(id.toString(), frame)).toMatchObject({ ok: true });
	});

	it("is refused to an agent machine with no connectors", async () => {
		setDevice({ machine: { mode: "agent", capabilities: { mcp: false } } });
		expect(await handleBrowserCall(id.toString(), frame)).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
	});

	it("is refused to an unpaired machine and when browser use is off", async () => {
		setDevice({ status: "pending", machine: { mode: "connectors" } });
		expect(await handleBrowserCall(id.toString(), frame)).toMatchObject({ ok: false });
		setDevice({ machine: { mode: "connectors" } });
		state.browser = "false";
		expect(await handleBrowserCall(id.toString(), frame)).toMatchObject({ ok: false });
	});
});
