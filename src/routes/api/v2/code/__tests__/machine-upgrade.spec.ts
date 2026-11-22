/**
 * The Upgrade button's endpoint (C159): `PATCH /api/v2/code/devices {action: "upgrade"}` asks the
 * owner's galopin to upgrade itself (`machine.upgrade`). Owner only; the computer must be paired,
 * online, outdated, and have reported `agent.upgrade.inPlace: true`. Driven against a fake machine
 * over a real WebSocket, like the other machine actions.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	createTestUser,
	cleanupTestData,
	type TestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { acceptMachineConnection } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { OpError } from "$lib/types/machineProtocol";
import { APP_VERSION } from "$lib/utils/appVersion";
import { listDevices } from "$lib/server/codeDevices";
import { UPGRADE_TIMEOUT_MS } from "$lib/galopinUpgrade";
import { FakeMachine, type FakeMachineOptions } from "../../../../../../tests/fake-machine";
import { PATCH as devicesPATCH } from "../devices/+server";

let httpServer: Server;
let wss: WebSocketServer;
let port: number;
let principal: MachinePrincipal;
let user: TestUser;
let openMachines: FakeMachine[] = [];

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
	principal = {
		userId: user.user._id,
		sub: user.user.hfUserId,
		iss: "http://fake-issuer.invalid",
		exp: Math.floor(Date.now() / 1000) + 3600,
		machineId: randomUUID(),
		machineName: "fake machine",
	};
});

afterEach(async () => {
	for (const machine of openMachines) machine.close();
	openMachines = [];
	await cleanupTestData();
});

function patch(deviceId: string, body: unknown, locals: App.Locals = user.locals) {
	return testRequest(devicesPATCH, {
		method: "PATCH",
		path: `/api/v2/code/devices?id=${deviceId}`,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		locals,
	});
}

async function connectAndPair(options: FakeMachineOptions = {}): Promise<FakeMachine> {
	const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {}, options);
	openMachines.push(machine);
	const { deviceId } = await machine.hello();
	expect((await patch(deviceId, { action: "confirm" })).status).toBe(200);
	await machine.waitForPaired();
	return machine;
}

const IN_PLACE = { inPlace: true, reason: "systemd" };

async function row(deviceId: string) {
	return collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
}

describe("PATCH devices {action: upgrade}", () => {
	it("starts the upgrade on the owner's computer and records it as running", async () => {
		const machine = await connectAndPair({ agentVersion: "0.1.0", agentUpgrade: IN_PLACE });
		const deviceId = machine.deviceId as string;
		let asked = 0;
		machine.onOp("machine.upgrade", () => {
			asked++;
			return { started: true };
		});
		const res = await patch(deviceId, { action: "upgrade" });
		expect(res.status).toBe(200);
		expect(asked).toBe(1);
		const stored = await row(deviceId);
		expect(stored?.agentUpgrade).toEqual(IN_PLACE);
		expect(stored?.upgradeRun).toMatchObject({
			state: "running",
			fromVersion: "0.1.0",
			targetVersion: APP_VERSION,
		});
		const listed = (await listDevices(user.locals)).find((d) => d.id === deviceId);
		expect(listed?.upgrade?.state).toBe("running");
		expect(listed?.agentUpgrade).toEqual(IN_PLACE);
	});

	it("is the owner's alone: another user gets a 404 and nothing reaches the computer", async () => {
		const machine = await connectAndPair({ agentUpgrade: IN_PLACE });
		let asked = 0;
		machine.onOp("machine.upgrade", () => {
			asked++;
			return { started: true };
		});
		const other = await createTestUser();
		const res = await patch(machine.deviceId as string, { action: "upgrade" }, other.locals);
		expect(res.status).toBe(404);
		expect(asked).toBe(0);
		expect((await row(machine.deviceId as string))?.upgradeRun).toBeUndefined();
	});

	it("refuses a computer that did not report inPlace true, whatever the reason", async () => {
		for (const agentUpgrade of [
			undefined,
			{ inPlace: false, reason: "mac_app" },
			{ inPlace: false, reason: "docker" },
			{ inPlace: false, reason: "foreground" },
			{ inPlace: false, reason: "disabled" },
		]) {
			principal = { ...principal, machineId: randomUUID() };
			const machine = await connectAndPair({ agentUpgrade });
			let asked = 0;
			machine.onOp("machine.upgrade", () => {
				asked++;
				return { started: true };
			});
			const res = await patch(machine.deviceId as string, { action: "upgrade" });
			expect(res.status, JSON.stringify(agentUpgrade)).toBe(409);
			expect(asked).toBe(0);
			expect((await row(machine.deviceId as string))?.upgradeRun).toBeUndefined();
		}
	});

	it("refuses an offline computer and one that is already up to date", async () => {
		const machine = await connectAndPair({ agentUpgrade: IN_PLACE });
		machine.close();
		await new Promise((r) => setTimeout(r, 300));
		expect((await patch(machine.deviceId as string, { action: "upgrade" })).status).toBe(409);

		principal = { ...principal, machineId: randomUUID() };
		const current = await connectAndPair({ agentUpgrade: IN_PLACE, agentVersion: APP_VERSION });
		expect((await patch(current.deviceId as string, { action: "upgrade" })).status).toBe(409);
	});

	it("keeps the run when the link closes instead of an answer, and lets the next hello decide", async () => {
		const machine = await connectAndPair({ agentVersion: "0.1.0", agentUpgrade: IN_PLACE });
		const deviceId = machine.deviceId as string;
		machine.onOp("machine.upgrade", () => {
			machine.close();
			return new Promise(() => {});
		});
		const res = await patch(deviceId, { action: "upgrade" });
		expect(res.status).toBe(200);
		expect((await row(deviceId))?.upgradeRun?.state).toBe("running");
		const next = new FakeMachine(
			`ws://127.0.0.1:${port}/api/v2/code/machine`,
			{},
			{
				agentVersion: APP_VERSION,
				agentUpgrade: IN_PLACE,
			}
		);
		openMachines.push(next);
		await next.hello();
		expect((await row(deviceId))?.upgradeRun?.state).toBe("done");
	});

	it("takes the record back when galopin refuses, and refuses a second start while one runs", async () => {
		const machine = await connectAndPair({ agentUpgrade: IN_PLACE });
		const deviceId = machine.deviceId as string;
		machine.onOp("machine.upgrade", () => {
			throw new OpError("unavailable", "could not start the upgrade: installer unreachable");
		});
		const failed = await patch(deviceId, { action: "upgrade" });
		expect(failed.status).toBe(503);
		expect((await row(deviceId))?.upgradeRun).toBeUndefined();

		machine.onOp("machine.upgrade", () => ({ started: true }));
		expect((await patch(deviceId, { action: "upgrade" })).status).toBe(200);
		expect((await patch(deviceId, { action: "upgrade" })).status).toBe(409);
	});
});

describe("upgrade state transitions", () => {
	async function started(version = "0.1.0") {
		const machine = await connectAndPair({ agentVersion: version, agentUpgrade: IN_PLACE });
		machine.onOp("machine.upgrade", () => ({ started: true }));
		expect((await patch(machine.deviceId as string, { action: "upgrade" })).status).toBe(200);
		return machine.deviceId as string;
	}

	async function reconnect(options: FakeMachineOptions) {
		const next = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {}, options);
		openMachines.push(next);
		await next.hello();
	}

	it("is done when the computer reconnects at or above the target", async () => {
		const deviceId = await started();
		await reconnect({ agentVersion: APP_VERSION, agentUpgrade: IN_PLACE });
		const stored = await row(deviceId);
		expect(stored?.upgradeRun).toMatchObject({ state: "done", version: APP_VERSION });
		const listed = (await listDevices(user.locals)).find((d) => d.id === deviceId);
		expect(listed?.upgrade?.state).toBe("done");
		expect(listed?.agentVersion).toBe(APP_VERSION);
	});

	it("ignores an old-version reconnect straight after the start (the old galopin still running)", async () => {
		const deviceId = await started();
		await reconnect({ agentVersion: "0.1.0", agentUpgrade: IN_PLACE });
		expect((await row(deviceId))?.upgradeRun?.state).toBe("running");
	});

	it("is failed when the old version comes back after the grace", async () => {
		const deviceId = await started();
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(deviceId) },
			{ $set: { "upgradeRun.startedAt": new Date(Date.now() - 3 * 60_000) } }
		);
		await reconnect({ agentVersion: "0.1.0", agentUpgrade: IN_PLACE });
		expect((await row(deviceId))?.upgradeRun).toMatchObject({ state: "failed", version: "0.1.0" });
	});

	it("reads failed when it never came back within the timeout", async () => {
		const deviceId = await started();
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(deviceId) },
			{ $set: { "upgradeRun.startedAt": new Date(Date.now() - UPGRADE_TIMEOUT_MS - 1000) } }
		);
		const listed = (await listDevices(user.locals)).find((d) => d.id === deviceId);
		expect(listed?.upgrade?.state).toBe("failed");
	});

	it("clears a failed run once the computer reports the target version", async () => {
		const deviceId = await started();
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(deviceId) },
			{ $set: { "upgradeRun.startedAt": new Date(Date.now() - 3 * 60_000) } }
		);
		await reconnect({ agentVersion: "0.1.0", agentUpgrade: IN_PLACE });
		expect((await row(deviceId))?.upgradeRun?.state).toBe("failed");
		await reconnect({ agentVersion: APP_VERSION, agentUpgrade: IN_PLACE });
		expect((await row(deviceId))?.upgradeRun).toBeUndefined();
	});

	it("does not rewrite a run another writer changed since the hello read it", async () => {
		const deviceId = await started();
		const before = (await row(deviceId))?.upgradeRun;
		// an old-version hello inside the grace changes nothing, so it writes nothing
		await reconnect({ agentVersion: "0.1.0", agentUpgrade: IN_PLACE });
		expect((await row(deviceId))?.upgradeRun?.startedAt).toEqual(before?.startedAt);
	});

	it("stops showing a finished result after ten minutes", async () => {
		const deviceId = await started();
		await reconnect({ agentVersion: APP_VERSION, agentUpgrade: IN_PLACE });
		expect((await listDevices(user.locals)).find((d) => d.id === deviceId)?.upgrade?.state).toBe(
			"done"
		);
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(deviceId) },
			{ $set: { "upgradeRun.finishedAt": new Date(Date.now() - 11 * 60_000) } }
		);
		expect(
			(await listDevices(user.locals)).find((d) => d.id === deviceId)?.upgrade
		).toBeUndefined();
	});

	it("drops a stale capability when an older galopin reports none", async () => {
		const deviceId = await started();
		await reconnect({ agentVersion: "0.1.0" });
		expect((await row(deviceId))?.agentUpgrade).toBeUndefined();
	});
});
