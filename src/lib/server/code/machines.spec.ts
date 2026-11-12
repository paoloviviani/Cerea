/**
 * The periodic gateway revalidation tick (ADR 0093 §4.7): every live
 * machine link, re-checked against the gateway every 60s in production
 * (`startMachineRevalidationLoop`); this drives one tick directly via
 * `revalidateLiveMachineConnections`, against a real WebSocket connection
 * established the same way `machine-forwarder.spec.ts` does.
 *
 * `isGatewayPreset` and `me` are mocked wholesale (config is a process-wide
 * snapshot no spec can flip per-test, and `me`'s real HTTP path would hit
 * `config.OPENAI_BASE_URL` for real) — the same reasoning
 * `updateUser.gateway.spec.ts` and `machineAuth.gateway.spec.ts` give.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	createTestUser,
	cleanupTestData,
	type TestUser,
} from "$lib/server/api/__tests__/testHelpers";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { FakeMachine } from "../../../../tests/fake-machine";
import type { GatewayCall, GatewayMe } from "$lib/server/identity/gatewayIdentity";

let meAnswer: GatewayCall<GatewayMe> = {
	ok: true,
	value: {
		id: "gw-default",
		is_admin: false,
		groups: [],
		sessions_valid_after: null,
		merged_at: null,
	},
};

vi.mock("$lib/server/identity/gatewayLogin", async () => {
	const actual = await vi.importActual<typeof import("$lib/server/identity/gatewayLogin")>(
		"$lib/server/identity/gatewayLogin"
	);
	return { ...actual, isGatewayPreset: () => true };
});

vi.mock("$lib/server/identity/gatewayIdentity", async () => {
	const actual = await vi.importActual<typeof import("$lib/server/identity/gatewayIdentity")>(
		"$lib/server/identity/gatewayIdentity"
	);
	return { ...actual, me: async () => meAnswer };
});

// Whether the connection's token still validates on its own (the
// revalidation's second question when the gateway refuses): "valid" by
// default, so the account-refused tests revoke as before.
let tokenCheck: "valid" | "invalid" | "unknown" = "valid";
// Whether a renewal (an `auth` frame) validates: the real one decodes a real
// token, which a fake machine has not got.
let renewalCheck: "valid" | "invalid" = "valid";
vi.mock("./machineAuth", async () => {
	const actual = await vi.importActual<typeof import("./machineAuth")>("./machineAuth");
	return {
		...actual,
		revalidateMachineAuth: async (_token: string, sub: string) => {
			if (renewalCheck === "invalid") throw new actual.MachineAuthError(401, "renewal refused");
			return { sub, iss: "i", exp: Math.floor(Date.now() / 1000) + 3600 };
		},
		validateMachineToken: async () => {
			if (tokenCheck === "valid") return { sub: "s", iss: "i", exp: 0 };
			if (tokenCheck === "invalid") throw new actual.MachineAuthError(401, "revoked at the IdP");
			throw new Error("issuer unreachable");
		},
	};
});

const {
	acceptMachineConnection,
	revalidateLiveMachineConnections,
	isMachineOnline,
	subscribeDeviceConnection,
	sendMcpMessage,
} = await import("./machines");
const { resetMachineUserCacheForTests } = await import("./machineAuth");

let httpServer: Server;
let wss: WebSocketServer;
let port: number;
let principal: MachinePrincipal;
let user: TestUser;

beforeAll(async () => {
	await ready;
	wss = new WebSocketServer({ noServer: true });
	httpServer = createServer();
	httpServer.on("upgrade", (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => {
			acceptMachineConnection(ws, req, principal, "test-token");
		});
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const address = httpServer.address();
	port = typeof address === "object" && address ? address.port : 0;
}, 30_000);

afterAll(async () => {
	wss.close();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(async () => {
	user = await createTestUser();
	await collections.users.updateOne(
		{ _id: user.user._id },
		{ $set: { gatewayUserId: `gw-${user.user._id.toString()}` } }
	);
	principal = {
		userId: user.user._id,
		sub: user.user.hfUserId,
		iss: "http://fake-issuer.invalid",
		exp: Math.floor(Date.now() / 1000) + 3600,
		machineId: randomUUID(),
		machineName: "fake machine",
	};
	meAnswer = {
		ok: true,
		value: {
			id: `gw-${user.user._id.toString()}`,
			is_admin: false,
			groups: [],
			sessions_valid_after: null,
			merged_at: null,
		},
	};
	resetMachineUserCacheForTests();
	tokenCheck = "valid";
	renewalCheck = "valid";
});

let openMachines: FakeMachine[] = [];

afterEach(async () => {
	for (const machine of openMachines) machine.close();
	openMachines = [];
	await cleanupTestData();
});

function waitForClose(machine: FakeMachine): Promise<number> {
	return new Promise((resolve) => machine.ws.on("close", (code: number) => resolve(code)));
}

describe("revalidateLiveMachineConnections", () => {
	it("leaves a connection alone when the gateway still says it's valid", async () => {
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		// The hello asked the gateway (cached for a minute); the tick under test must ask again.
		resetMachineUserCacheForTests();

		await revalidateLiveMachineConnections();

		expect(isMachineOnline(deviceId)).toBe(true);
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		expect(device?.status).not.toBe("revoked");
	});

	it("closes the connection and revokes the device when the gateway refuses", async () => {
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		// The hello asked the gateway (cached for a minute); the tick under test must ask again.
		resetMachineUserCacheForTests();
		const closed = waitForClose(machine);

		meAnswer = { ok: false, refused: true, status: 401, message: "disabled" };
		await revalidateLiveMachineConnections();

		await closed;
		expect(isMachineOnline(deviceId)).toBe(false);
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		expect(device?.status).toBe("revoked");
		expect(device?.revokedReason).toBe("account_disabled");
		expect(device?.revokedAt).toBeInstanceOf(Date);
	});

	it("closes with 4404 and revokes nothing when the join gate refuses the account", async () => {
		// ADR 0095: a 403 outside_access_groups is a loss regaining the group
		// reverses. The device stays enrolled; the machine retries with its
		// own backoff and the link comes back when the groups say so.
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		// The hello asked the gateway (cached for a minute); the tick under test must ask again.
		resetMachineUserCacheForTests();
		const closed = waitForClose(machine);

		meAnswer = {
			ok: false,
			refused: true,
			status: 403,
			message: "Your account is no longer in a group that may use this deployment.",
			code: "outside_access_groups",
		};
		await revalidateLiveMachineConnections();

		expect(await closed).toBe(4404);
		expect(isMachineOnline(deviceId)).toBe(false);
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		expect(device?.status).not.toBe("revoked");
	});

	it("closes with 4404 and revokes nothing when the code_agents gate refuses the account", async () => {
		// ADR 0096: a 403 agents_not_allowed is a loss regaining the flag
		// reverses — treated exactly like outside_access_groups. The device
		// stays enrolled; the machine retries with its own backoff and the
		// link comes back when a group grants the capability.
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		// The hello asked the gateway (cached for a minute); the tick under test must ask again.
		resetMachineUserCacheForTests();
		const closed = waitForClose(machine);

		meAnswer = {
			ok: false,
			refused: true,
			status: 403,
			message: "This account may not use coding agents on this deployment.",
			code: "agents_not_allowed",
		};
		await revalidateLiveMachineConnections();

		expect(await closed).toBe(4404);
		expect(isMachineOnline(deviceId)).toBe(false);
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		expect(device?.status).not.toBe("revoked");
	});

	function meWith(capabilities: NonNullable<GatewayMe["capabilities"]>): GatewayCall<GatewayMe> {
		return {
			ok: true,
			value: {
				id: `gw-${user.user._id.toString()}`,
				is_admin: false,
				groups: [],
				sessions_valid_after: null,
				merged_at: null,
				capabilities,
			},
		};
	}
	const CONNECTORS = { mode: "connectors", capabilities: { mcp: true } };

	it("closes a connectors machine with 4404, revoking nothing, when local_connectors is lost", async () => {
		const machine = new FakeMachine(
			`ws://127.0.0.1:${port}/api/v2/code/machine`,
			{},
			{ backends: [], machine: CONNECTORS }
		);
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		// The hello asked the gateway (cached for a minute); the tick under test must ask again.
		resetMachineUserCacheForTests();
		const closed = waitForClose(machine);

		meAnswer = meWith({ code_agents: true, api_keys: true, local_connectors: false });
		await revalidateLiveMachineConnections();

		expect(await closed).toBe(4404);
		expect(isMachineOnline(deviceId)).toBe(false);
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		expect(device?.status).not.toBe("revoked");
	});

	it("keeps a connectors machine for a person with only local_connectors", async () => {
		meAnswer = meWith({ code_agents: false, api_keys: true, local_connectors: true });
		const connectors = new FakeMachine(
			`ws://127.0.0.1:${port}/api/v2/code/machine`,
			{},
			{ backends: [], machine: CONNECTORS }
		);
		openMachines.push(connectors);
		const { deviceId } = await connectors.hello();
		await revalidateLiveMachineConnections();
		expect(isMachineOnline(deviceId)).toBe(true);
	});

	it("closes an agent machine with 4404 when only local_connectors is held", async () => {
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		// The hello asked the gateway (cached for a minute); the tick under test must ask again.
		resetMachineUserCacheForTests();
		const closed = waitForClose(machine);

		meAnswer = meWith({ code_agents: false, api_keys: true, local_connectors: true });
		await revalidateLiveMachineConnections();

		expect(await closed).toBe(4404);
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		expect(device?.status).not.toBe("revoked");
	});

	it("refuses a connectors hello with 4404 when the person lacks local_connectors", async () => {
		meAnswer = meWith({ code_agents: true, api_keys: true, local_connectors: false });
		const machine = new FakeMachine(
			`ws://127.0.0.1:${port}/api/v2/code/machine`,
			{},
			{ backends: [], machine: CONNECTORS }
		);
		openMachines.push(machine);
		const closed = waitForClose(machine);
		machine.hello().catch(() => undefined);
		expect(await closed).toBe(4404);
		const devices = await collections.codeDevices
			.find({ machineId: principal.machineId })
			.toArray();
		expect(devices).toEqual([]);
	});

	it("refuses an agent hello with 4404 when the person has only local_connectors", async () => {
		meAnswer = meWith({ code_agents: false, api_keys: true, local_connectors: true });
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const closed = waitForClose(machine);
		machine.hello().catch(() => undefined);
		expect(await closed).toBe(4404);
	});

	it("accepts a connectors hello for a person with only local_connectors", async () => {
		meAnswer = meWith({ code_agents: false, api_keys: true, local_connectors: true });
		const machine = new FakeMachine(
			`ws://127.0.0.1:${port}/api/v2/code/machine`,
			{},
			{ backends: [], machine: CONNECTORS }
		);
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		// The hello asked the gateway (cached for a minute); the tick under test must ask again.
		resetMachineUserCacheForTests();
		expect(isMachineOnline(deviceId)).toBe(true);
	});

	it("asks the machine to renew, and revokes nothing, when the refused token itself no longer validates", async () => {
		// GitLab revokes the previous access token on refresh: for a moment the
		// connection holds a token the gateway refuses while the machine is fine.
		// The first tick that sees it waits (the machine is about to hand a new
		// token over); the same token refused on the next tick closes with 4401.
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		// The hello asked the gateway (cached for a minute); the tick under test must ask again.
		resetMachineUserCacheForTests();
		const closed = waitForClose(machine);

		meAnswer = { ok: false, refused: true, status: 401, message: "Invalid API key provided." };
		tokenCheck = "invalid";
		await revalidateLiveMachineConnections();
		expect(isMachineOnline(deviceId)).toBe(true); // one tick of grace

		resetMachineUserCacheForTests();
		await revalidateLiveMachineConnections();

		expect(await closed).toBe(4401);
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		expect(device?.status).not.toBe("revoked");
		expect(device?.revokedAt).toBeUndefined();
	});

	it("keeps the link when the machine hands a fresh token over after the refused tick", async () => {
		// The shim refreshed (GitLab revoked the old token) and the `auth` frame with the
		// new one reaches Cerea after the tick that saw the old one refused: no drop at all.
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		resetMachineUserCacheForTests();
		let closedWith: number | null = null;
		machine.ws.on("close", (code: number) => (closedWith = code));

		meAnswer = { ok: false, refused: true, status: 401, message: "Invalid API key provided." };
		tokenCheck = "invalid";
		await revalidateLiveMachineConnections(); // the old token, refused: grace

		machine.ws.send(JSON.stringify({ type: "auth", token: "the-new-token" }));
		await new Promise((resolve) => setTimeout(resolve, 100)); // Cerea validates and swaps it

		// The gateway accepts the new token on the next tick.
		resetMachineUserCacheForTests();
		meAnswer = {
			ok: true,
			value: {
				id: `gw-${user.user._id.toString()}`,
				is_admin: false,
				groups: [],
				sessions_valid_after: null,
				merged_at: null,
			},
		};
		tokenCheck = "valid";
		await revalidateLiveMachineConnections();
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(closedWith).toBeNull();
		expect(isMachineOnline(deviceId)).toBe(true);
	});

	it("gives a handed-over token its own tick of grace, then closes if that one is refused too", async () => {
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		resetMachineUserCacheForTests();
		const closed = waitForClose(machine);

		meAnswer = { ok: false, refused: true, status: 401, message: "Invalid API key provided." };
		tokenCheck = "invalid";
		await revalidateLiveMachineConnections(); // first token: grace
		machine.ws.send(JSON.stringify({ type: "auth", token: "second-token" }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		resetMachineUserCacheForTests();
		await revalidateLiveMachineConnections(); // second token, refused for the first time: grace
		expect(isMachineOnline(deviceId)).toBe(true);
		resetMachineUserCacheForTests();
		await revalidateLiveMachineConnections(); // the same second token again: closed

		expect(await closed).toBe(4401);
	});

	it("still revokes at once when the gateway refuses a token that does validate", async () => {
		// The account is what was refused, not the token: no grace.
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		resetMachineUserCacheForTests();
		const closed = waitForClose(machine);

		meAnswer = { ok: false, refused: true, status: 401, message: "account disabled" };
		tokenCheck = "valid";
		await revalidateLiveMachineConnections();

		expect(await closed).toBe(4403);
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		expect(device?.status).toBe("revoked");
	});

	it("revokes nothing when the token cannot be checked at all", async () => {
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		// The hello asked the gateway (cached for a minute); the tick under test must ask again.
		resetMachineUserCacheForTests();
		const closed = waitForClose(machine);

		meAnswer = { ok: false, refused: true, status: 401, message: "Invalid API key provided." };
		tokenCheck = "unknown";
		await revalidateLiveMachineConnections();

		expect(await closed).toBe(1013);
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		expect(device?.status).not.toBe("revoked");
	});

	it("revokes when sessions_valid_after postdates the device's own enrolment", async () => {
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
		// The hello asked the gateway (cached for a minute); the tick under test must ask again.
		resetMachineUserCacheForTests();
		const closed = waitForClose(machine);

		meAnswer = {
			ok: true,
			value: {
				id: `gw-${user.user._id.toString()}`,
				is_admin: false,
				groups: [],
				sessions_valid_after: new Date(Date.now() + 60_000).toISOString(),
				merged_at: null,
			},
		};
		await revalidateLiveMachineConnections();

		await closed;
		expect(isMachineOnline(deviceId)).toBe(false);
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		expect(device?.status).toBe("revoked");
	});

	it("does not revoke a device it has never seen (no live connection)", async () => {
		// No machine ever connected: the tick only walks live connections, so
		// this is really asserting it doesn't throw over an empty registry.
		await expect(revalidateLiveMachineConnections()).resolves.toBeUndefined();
	});
});

describe("the welcome is the first frame", () => {
	it("goes out before anything a connection listener sends in reaction to the machine coming online", async () => {
		// The terminal relay (and others) subscribe to a device's connection changes and may
		// send a frame the moment it comes online. That frame used to overtake the welcome, and
		// galopin dropped the connection ("expected welcome, got req").
		const first = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(first);
		const { deviceId } = await first.hello();
		first.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(isMachineOnline(deviceId)).toBe(false);

		const unsubscribe = subscribeDeviceConnection(deviceId, (online) => {
			if (online) sendMcpMessage(deviceId, "ch-1", { jsonrpc: "2.0", method: "ping", id: 1 });
		});
		try {
			const second = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
			openMachines.push(second);
			const types: string[] = [];
			second.ws.on("message", (raw: Buffer | string, isBinary: boolean) => {
				if (isBinary) return;
				try {
					types.push(JSON.parse(raw.toString()).type);
				} catch {
					/* not JSON */
				}
			});
			await second.hello();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(types[0]).toBe("welcome");
			expect(types).toContain("mcp"); // the listener's frame did go out, after it
		} finally {
			unsubscribe();
		}
	});
});
