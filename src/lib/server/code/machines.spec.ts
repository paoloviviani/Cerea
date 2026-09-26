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

const { acceptMachineConnection, revalidateLiveMachineConnections, isMachineOnline } =
	await import("./machines");
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

		await revalidateLiveMachineConnections();

		expect(isMachineOnline(deviceId)).toBe(true);
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		expect(device?.status).not.toBe("revoked");
	});

	it("closes the connection and revokes the device when the gateway refuses", async () => {
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
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

	it("revokes when sessions_valid_after postdates the device's own enrolment", async () => {
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(machine);
		const { deviceId } = await machine.hello();
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
