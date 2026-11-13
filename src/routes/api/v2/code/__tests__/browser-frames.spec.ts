/**
 * The browser runtime's live-view frames (kind 0x04, PROTOCOL.md §9.2) from a machine to whoever
 * subscribed to that machine's frames: routed by device, in order, and to nobody else.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collections, ready } from "$lib/server/database";
import { createTestUser, cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { acceptMachineConnection, subscribeBrowserFrames } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { MACHINE_PATH, decodeBrowserFramePayload } from "$lib/types/machineProtocol";
import { FakeMachine } from "../../../../../../tests/fake-machine";
import { PATCH as devicesPATCH } from "../devices/+server";

function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("expected a value");
	return value;
}

let httpServer: Server;
let machineWss: WebSocketServer;
let port: number;
let principal: MachinePrincipal;
let machines: FakeMachine[] = [];

beforeAll(async () => {
	await ready;
	machineWss = new WebSocketServer({ noServer: true });
	httpServer = createServer();
	httpServer.on("upgrade", (req, socket, head) => {
		if (new URL(req.url ?? "/", "http://internal").pathname === MACHINE_PATH) {
			machineWss.handleUpgrade(req, socket, head, (ws) =>
				acceptMachineConnection(ws, req, principal, "test-token")
			);
			return;
		}
		socket.destroy();
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const address = httpServer.address();
	port = typeof address === "object" && address ? address.port : 0;
}, 30_000);

afterAll(async () => {
	machineWss.close();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(async () => {
	const user = await createTestUser();
	principal = {
		userId: user.user._id,
		sub: user.user.hfUserId,
		iss: "http://fake-issuer.invalid",
		exp: Math.floor(Date.now() / 1000) + 3600,
		machineId: randomUUID(),
		machineName: "fake machine",
	};
	(globalThis as { __user?: typeof user }).__user = user;
});

afterEach(async () => {
	for (const machine of machines) machine.close();
	machines = [];
	await cleanupTestData();
	void collections;
});

async function pairedMachine(): Promise<FakeMachine> {
	const user = must((globalThis as { __user?: Awaited<ReturnType<typeof createTestUser>> }).__user);
	principal = { ...principal, machineId: randomUUID() };
	const machine = new FakeMachine(`ws://127.0.0.1:${port}${MACHINE_PATH}`, {}, {});
	machines.push(machine);
	const { deviceId } = await machine.hello();
	const res = await testRequest(devicesPATCH, {
		method: "PATCH",
		path: `/api/v2/code/devices?id=${deviceId}`,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: "confirm" }),
		locals: user.locals,
	});
	expect(res.status).toBe(200);
	await machine.waitForPaired();
	return machine;
}

describe("browser live-view frames from a machine", () => {
	it("reach the subscribers of that machine, in order, with the viewport and the JPEG", async () => {
		const machine = await pairedMachine();
		const other = await pairedMachine();
		const got: Array<{ seq: number; width: number; height: number; jpeg: string }> = [];
		const elsewhere: number[] = [];
		const stop = subscribeBrowserFrames(must(machine.deviceId), (seq, payload) => {
			const frame = must(decodeBrowserFramePayload(payload));
			got.push({ seq, width: frame.width, height: frame.height, jpeg: frame.jpeg.toString("hex") });
		});
		const stopOther = subscribeBrowserFrames(must(other.deviceId), (seq) => elsewhere.push(seq));

		machine.sendBrowserFrame("ch_aaaaaaaaaaaa", 1, 1280, 800, Buffer.from([0xff, 0xd8, 1]));
		machine.sendBrowserFrame("ch_aaaaaaaaaaaa", 2, 390, 844, Buffer.from([0xff, 0xd8, 2]));
		await vi_waitFor(() => got.length === 2);
		expect(got).toEqual([
			{ seq: 1, width: 1280, height: 800, jpeg: "ffd801" },
			{ seq: 2, width: 390, height: 844, jpeg: "ffd802" },
		]);
		expect(elsewhere).toEqual([]);

		// Unsubscribed: nothing more is delivered, and nothing breaks.
		stop();
		machine.sendBrowserFrame("ch_aaaaaaaaaaaa", 3, 1280, 800, Buffer.from([0xff, 0xd8, 3]));
		await new Promise((r) => setTimeout(r, 100));
		expect(got).toHaveLength(2);
		stopOther();
	});
});

async function vi_waitFor(cond: () => boolean, ms = 3000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("timed out");
}
