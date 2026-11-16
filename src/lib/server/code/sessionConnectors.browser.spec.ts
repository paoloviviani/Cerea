/** M8: the browser runtime is never a connector an agent can be given. */
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
	localDevicesOf: async () => [{ _id: new ObjectId(), name: "Laptop" }],
}));
vi.mock("$lib/server/code/agentSessions", () => ({
	ownedDevice: async () => ({
		_id: new ObjectId(),
		status: "paired",
		machine: { capabilities: { mcp: true } },
	}),
}));

const { availableOptions, listChoices } = await import("./sessionConnectors");

describe("the options an agent can be given", () => {
	it("lists the machine's own servers but not the browser runtime", async () => {
		servers.list = [
			{ name: "calendar", transport: "stdio", state: "ready" },
			{ name: "cerea-browser", transport: "stdio", state: "ready" },
		];
		const device = new ObjectId().toString();
		const options = await availableOptions(new ObjectId(), device);
		expect(options.map((o) => o.name)).toEqual(["calendar"]);
		const choices = await listChoices(new ObjectId());
		expect(choices.computers[0].options.map((o) => o.name)).toEqual(["calendar"]);
	});
});
