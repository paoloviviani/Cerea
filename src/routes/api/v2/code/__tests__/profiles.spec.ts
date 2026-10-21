/**
 * A machine's delegate profiles (PROTOCOL.md §6 "Delegate profiles"): the
 * forwarder reads and replaces them through `profiles.list` / `profiles.set`,
 * for the device's own owner only. Driven end to end against a fake machine
 * over a real WebSocket; the fake validates the way galopin does.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import superjson from "superjson";
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
import { FakeMachine, type FakeMachineOptions } from "../../../../../../tests/fake-machine";
import {
	DELETE as forwarderDELETE,
	GET as forwarderGET,
	POST as forwarderPOST,
} from "../[...path]/+server";
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
	handler: typeof forwarderGET | typeof forwarderDELETE | typeof forwarderPOST,
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

const MODELS = [
	{ id: "gw/fast", label: "Fast", providerId: "gw" },
	{ id: "gw/deep", label: "Deep", providerId: "gw" },
];

function url(deviceId: string) {
	return `/api/v2/code/v1/profiles?device=${deviceId}`;
}

function post(deviceId: string, body: unknown, locals: App.Locals = user.locals) {
	return forwarder(forwarderPOST, url(deviceId), {
		method: "POST",
		body: JSON.stringify(body),
		locals,
	});
}

type Listed = { default: string | null; profiles: Array<{ name: string; model: string }> };

describe("v1/profiles", () => {
	it("lists the machine's profiles sorted, with null fields and entries it cannot use dropped", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		machine.onOp("profiles.list", () => ({
			default: "fast",
			profiles: {
				fast: { model: "gw/fast" },
				deep: { model: "gw/deep" },
				nomodel: { model: null },
			},
		}));
		const res = await forwarder(forwarderGET, url(deviceId), { locals: user.locals });
		expect(res.status).toBe(200);
		expect(await parse<Listed>(res)).toEqual({
			default: "fast",
			profiles: [
				{ name: "deep", model: "gw/deep" },
				{ name: "fast", model: "gw/fast" },
			],
		});
		machine.onOp("profiles.list", () => ({ default: null, profiles: null }));
		const empty = await parse<Listed>(
			await forwarder(forwarderGET, url(deviceId), { locals: user.locals })
		);
		expect(empty).toEqual({ default: null, profiles: [] });
		machine.close();
	});

	it("replaces the whole set, sends the wire shape and audits without model ids", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		machine.model.models = MODELS;
		const sent: unknown[] = [];
		const real = machine.model;
		machine.onOp("profiles.set", (args: unknown) => {
			sent.push(args);
			real.delegateProfiles = args as typeof real.delegateProfiles;
			return real.delegateProfiles;
		});
		const res = await post(deviceId, {
			default: "deep",
			profiles: [
				{ name: "fast", model: "gw/fast" },
				{ name: "deep", model: "gw/deep" },
			],
		});
		expect(res.status).toBe(200);
		expect(sent).toEqual([
			{ default: "deep", profiles: { fast: { model: "gw/fast" }, deep: { model: "gw/deep" } } },
		]);
		expect((await parse<Listed>(res)).default).toBe("deep");
		const rows = await collections.codeAudit
			.find({ action: "profiles.set", deviceId: new ObjectId(deviceId) })
			.toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0].outcome).toBe("sent");
		expect(rows[0].name).toBe("deep");
		expect(JSON.stringify(rows[0])).not.toContain("gw/");
		machine.close();
	});

	it("passes the machine's refusal through as a 400 and audits it refused", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		machine.model.models = MODELS;
		const res = await post(deviceId, {
			default: null,
			profiles: [{ name: "ghost", model: "gw/none" }],
		});
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("not offered");
		expect(machine.model.delegateProfiles).toEqual({ default: null, profiles: {} });
		const rows = await collections.codeAudit
			.find({ action: "profiles.set", deviceId: new ObjectId(deviceId) })
			.toArray();
		expect(rows.map((r) => r.outcome)).toEqual(["refused"]);
		machine.close();
	});

	it("refuses a malformed body before it reaches the machine", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const calls: unknown[] = [];
		machine.onOp("profiles.set", (args: unknown) => {
			calls.push(args);
			return {};
		});
		for (const body of [
			{},
			{ default: null },
			{ default: 3, profiles: [] },
			{ default: null, profiles: [{ name: "a" }] },
			{
				default: null,
				profiles: [
					{ name: "a", model: "m" },
					{ name: "a", model: "m" },
				],
			},
			{
				default: null,
				profiles: Array.from({ length: 33 }, (_, i) => ({ name: `p${i}`, model: "m" })),
			},
		]) {
			expect((await post(deviceId, body)).status).toBe(400);
		}
		expect(calls).toHaveLength(0);
		machine.close();
	});

	it("answers 404 with the machine's own sentence from a galopin without the ops", async () => {
		const machine = await connectAndPair({ delegateProfiles: false });
		const deviceId = machine.deviceId as string;
		expect((await forwarder(forwarderGET, url(deviceId), { locals: user.locals })).status).toBe(
			404
		);
		expect((await post(deviceId, { default: null, profiles: [] })).status).toBe(404);
		machine.close();
	});

	it("is the device owner's alone: another person's request is a 404 and reaches nothing", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		machine.model.models = MODELS;
		const other = await createTestUser();
		expect((await forwarder(forwarderGET, url(deviceId), { locals: other.locals })).status).toBe(
			404
		);
		const res = await post(
			deviceId,
			{ default: null, profiles: [{ name: "a", model: "gw/fast" }] },
			other.locals
		);
		expect(res.status).toBe(404);
		expect(machine.model.delegateProfiles.profiles).toEqual({});
		machine.close();
	});

	it("is refused for an unpaired or unknown device and for a missing login", async () => {
		const res = await forwarder(forwarderGET, url(new ObjectId().toString()), {
			locals: user.locals,
		});
		expect(res.status).toBe(404);
		const machine = await connectAndPair();
		const anon = await forwarder(forwarderGET, url(machine.deviceId as string), {
			locals: { ...user.locals, user: undefined } as App.Locals,
		});
		expect([401, 403, 404]).toContain(anon.status);
		machine.close();
	});

	it("is a 502 when the machine is offline", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		machine.close();
		await new Promise((r) => setTimeout(r, 200));
		const res = await forwarder(forwarderGET, url(deviceId), { locals: user.locals });
		expect([502, 503]).toContain(res.status);
	});
});
