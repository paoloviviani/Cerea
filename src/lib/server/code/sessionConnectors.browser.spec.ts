/** M8: the browser runtime is never a connector an agent session can opt in to. */
import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const servers = vi.hoisted(() => ({
	list: [] as Array<{ name: string; transport: string; state: string; description?: string }>,
}));

vi.mock("$lib/server/database", () => ({ collections: {} }));
vi.mock("$lib/server/codeEnabled", () => ({ localConnectorsEnabled: () => true }));
vi.mock("$lib/server/mcp/turnConnectors", () => ({
	resolveConnectors: async () => ({ connectors: [], blocked: [] }),
}));
vi.mock("$lib/server/mcp/deploymentModes", () => ({
	policyIn: () => ({ mode: "on" }),
	loadPolicies: async () => new Map(),
	isLocalKey: () => false,
}));
vi.mock("$lib/server/mcp/local", () => ({
	serversOf: async () => ({ servers: servers.list, live: true }),
	servesLocalConnectors: () => true,
}));
vi.mock("$lib/server/code/agentSessions", () => ({
	ownedDevice: async () => ({ status: "paired", machine: { capabilities: { mcp: true } } }),
}));

const { connectorOptions } = await import("./sessionConnectors");

describe("connectorOptions", () => {
	it("lists the machine's own servers but not the browser runtime", async () => {
		servers.list = [
			{ name: "calendar", transport: "stdio", state: "ready" },
			{ name: "cerea-browser", transport: "stdio", state: "ready" },
		];
		const device = new ObjectId().toString();
		const options = await connectorOptions(new ObjectId(), device);
		expect(options.map((o) => o.name)).toEqual(["calendar"]);
	});
});
