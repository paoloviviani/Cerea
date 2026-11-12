/**
 * The browser runtime is a machine's `cerea-browser` server: found by `browseMachinesFor`, and
 * kept out of every list and selection of the user's own connectors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const state = vi.hoisted(() => ({
	browser: "true",
	sealing: true,
	connectors: true,
	access: "ok" as "ok" | "not_granted",
	online: new Set<string>(),
	devices: [] as Array<Record<string, unknown>>,
	lists: new Map<string, Array<Record<string, unknown>>>(),
}));

vi.mock("$lib/server/config", () => ({
	config: {
		get CHAT_BROWSER_ENABLED() {
			return state.browser;
		},
	},
}));
vi.mock("$lib/server/mcp/secretBox", () => ({ sealingAvailable: () => state.sealing }));
vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("$lib/server/codeEnabled", () => ({
	localConnectorsEnabled: () => state.connectors,
	localConnectorsAccessFor: async () => state.access,
}));
vi.mock("$lib/server/code/machines", () => ({
	isMachineOnline: (id: string) => state.online.has(id),
	MachineLink: class {
		constructor(private readonly id: string) {}
		async mcpList() {
			return state.lists.get(this.id) ?? [];
		}
	},
}));
vi.mock("$lib/server/database", () => {
	const cursor = () => ({
		sort: () => ({ toArray: async () => state.devices }),
		toArray: async () => state.devices,
	});
	return {
		collections: {
			codeDevices: {
				find: cursor,
				updateOne: async () => ({}),
			},
		},
	};
});
vi.mock("$lib/server/mcp/deploymentModes", () => ({
	loadSwitches: async () => ({ on: new Set<string>() }),
}));

const { browseMachinesFor } = await import("./availability");
const { localConnectorViews, resolveLocalSelection } = await import("$lib/server/mcp/local");
const { localMachineViews } = await import("$lib/server/localConnectors");
const { localConnectorId } = await import("$lib/server/mcp/localUrl");

const userId = new ObjectId();
const user = { _id: userId } as never;

function device(name: string, servers: Array<Record<string, unknown>>, online = true) {
	const _id = new ObjectId();
	state.devices.push({
		_id,
		userId,
		name,
		status: "paired",
		machine: { mode: "connectors" },
		mcpServers: servers,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	if (online) state.online.add(_id.toString());
	state.lists.set(_id.toString(), servers);
	return _id.toString();
}

const runtime = (st = "ready") => ({ name: "cerea-browser", transport: "stdio", state: st });
const calendar = { name: "calendar", transport: "stdio", state: "ready" };

beforeEach(() => {
	state.browser = "true";
	state.sealing = true;
	state.connectors = true;
	state.access = "ok";
	state.online.clear();
	state.devices.length = 0;
	state.lists.clear();
});

describe("browseMachinesFor", () => {
	it("lists the user's online machines that run a ready browser runtime", async () => {
		const laptop = device("Laptop", [runtime(), calendar]);
		device("Desk", [calendar]);
		device("Old", [runtime()], false);
		device("Broken", [runtime("invalid")]);
		expect(await browseMachinesFor({ user } as never)).toEqual([{ id: laptop, name: "Laptop" }]);
	});

	it("is empty when the feature is off, local connectors are off, or the user has no access", async () => {
		device("Laptop", [runtime()]);
		state.browser = "false";
		expect(await browseMachinesFor({ user } as never)).toEqual([]);
		state.browser = "true";
		state.connectors = false;
		expect(await browseMachinesFor({ user } as never)).toEqual([]);
		state.connectors = true;
		state.access = "not_granted";
		expect(await browseMachinesFor({ user } as never)).toEqual([]);
	});

	it("is empty when the deployment cannot keep the grant key (no CHAT_SECRET_KEY)", async () => {
		device("Laptop", [runtime()]);
		state.sealing = false;
		expect(await browseMachinesFor({ user } as never)).toEqual([]);
	});

	it("is empty with no user", async () => {
		device("Laptop", [runtime()]);
		expect(await browseMachinesFor(undefined)).toEqual([]);
		expect(await browseMachinesFor({ user: undefined } as never)).toEqual([]);
	});
});

describe("the runtime is not one of the user's connectors", () => {
	it("is left out of the connector list", async () => {
		device("Laptop", [runtime(), calendar]);
		const views = await localConnectorViews(userId);
		expect(views.map((v) => v.local?.server)).toEqual(["calendar"]);
	});

	it("is left out of the machine view in settings", async () => {
		device("Laptop", [runtime(), calendar]);
		const [machine] = await localMachineViews(userId);
		expect(machine.servers.map((s) => s.name)).toEqual(["calendar"]);
	});

	it("cannot be selected as a chat connector by naming it", async () => {
		const id = device("Laptop", [runtime(), calendar]);
		const resolved = await resolveLocalSelection({
			connectorIds: [localConnectorId(id, "cerea-browser"), localConnectorId(id, "calendar")],
			userId,
		});
		expect(resolved.servers.map((s) => s.name)).toEqual(["calendar · on Laptop"]);
		expect(resolved.unavailable).toEqual([]);
	});
});
