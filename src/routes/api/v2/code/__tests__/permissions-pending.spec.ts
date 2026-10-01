/**
 * The Needs-you inbox's forwarder row (`GET v1/permissions/pending`): one
 * round trip per machine to galopin's `permissions.pending` op, passed
 * through as the machine answered — a read of live state, never a queue.
 * Driven end to end against a fake machine over a real WebSocket, like
 * `machine-forwarder.spec.ts`.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import superjson from "superjson";
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { ready } from "$lib/server/database";
import {
	createTestUser,
	cleanupTestData,
	type TestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { acceptMachineConnection } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { FakeMachine, type FakeMachineOptions } from "../../../../../../tests/fake-machine";
import { GET as forwarderGET, POST as forwarderPOST } from "../[...path]/+server";
import { PATCH as devicesPATCH } from "../devices/+server";

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
	principal = {
		userId: user.user._id,
		sub: user.user.hfUserId,
		iss: "http://fake-issuer.invalid",
		exp: Math.floor(Date.now() / 1000) + 3600,
		machineId: randomUUID(),
		machineName: "fake machine",
	};
});

let openMachines: FakeMachine[] = [];

afterEach(async () => {
	for (const machine of openMachines) machine.close();
	openMachines = [];
	await cleanupTestData();
});

async function parse<T>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

async function forwarder(
	handler: typeof forwarderGET,
	urlPath: string,
	opts: { method?: string; body?: string; locals: App.Locals }
): Promise<Response> {
	const restPath = urlPath.replace(/^\/api\/v2\/code\//, "").split("?")[0];
	return testRequest(handler, {
		method: opts.method,
		path: urlPath,
		body: opts.body,
		headers: { "content-type": "application/json" },
		locals: opts.locals,
		params: { path: restPath },
	});
}

async function connectAndPair(options: FakeMachineOptions = {}): Promise<FakeMachine> {
	const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {}, options);
	openMachines.push(machine);
	const { deviceId, status } = await machine.hello();
	expect(status).toBe("pending");
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

describe("GET v1/permissions/pending", () => {
	it("passes the machine's pending asks through with their session context", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const asked: unknown[] = [];
		machine.onOp("permissions.pending", (args: unknown) => {
			asked.push(args);
			return {
				permissions: [
					{
						sessionId: "s1",
						workspaceId: "w1",
						sessionTitle: "Build it",
						request: {
							id: "perm-1",
							sessionId: "s1",
							tool: "bash",
							title: "Run the tests",
							patterns: [],
							metadata: {},
							always: [],
						},
					},
				],
				questions: [
					{
						sessionId: "s2",
						workspaceId: "w1",
						sessionTitle: "Second",
						request: { id: "que-1", questions: [{ question: "Which?", options: [] }] },
					},
				],
			};
		});

		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/permissions/pending?device=${deviceId}`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(200);
		expect(asked).toEqual([{}]);
		const body = await parse<{
			permissions: Array<{ sessionId: string; sessionTitle: string }>;
			questions: Array<{ sessionId: string; sessionTitle: string }>;
		}>(res);
		expect(body.permissions.map((p) => [p.sessionId, p.sessionTitle])).toEqual([
			["s1", "Build it"],
		]);
		expect(body.questions.map((q) => [q.sessionId, q.sessionTitle])).toEqual([["s2", "Second"]]);
		machine.close();
	});

	it("answers two empty lists when nothing is waiting", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/permissions/pending?device=${deviceId}`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(200);
		expect(await parse(res)).toEqual({ permissions: [], questions: [] });
		machine.close();
	});

	it("answers instantly, never a hang, once the machine goes offline (R1)", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		machine.close();
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		const start = Date.now();
		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/permissions/pending?device=${deviceId}`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(502);
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("refuses a device that belongs to a different user", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const otherUser = await createTestUser();
		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/permissions/pending?device=${deviceId}`,
			{ locals: otherUser.locals }
		);
		expect(res.status).toBe(404);
		machine.close();
	});

	it("is read-only: POST to the same path is not offered", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/permissions/pending?device=${deviceId}`,
			{ method: "POST", body: JSON.stringify({}), locals: user.locals }
		);
		expect(res.status).toBe(404);
		machine.close();
	});
});
