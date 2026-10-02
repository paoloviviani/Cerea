/**
 * The /code stale-session guard (`hooks/handle.ts`): every request under
 * `/api/v2/code/` except `/status` answers `401 {code:"reauth_required"}` while
 * the session's sign-in is older than 7 days — or has no `authTime` at all.
 *
 * This is the spec that must FAIL when a route is added without being
 * thought about. It walks (1) every entry of the forwarder's `RULES`
 * allowlist through a sample path, failing when an entry has none, (2) every
 * route file under `api/v2/code/`, failing when one is not in the known list
 * below, and (3) a path no route has yet, which the prefix guard must refuse
 * all the same. The guard runs in the hook, so the handler behind it is a
 * stub: what is under test is that nothing reaches a handler while stale.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import superjson from "superjson";
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
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
import { GET as devicesGET } from "../devices/+server";
import { GET as statusGET } from "../status/+server";
import { GET as streamGET } from "../agents/[id]/stream/+server";
import { _RULES } from "../[...path]/+server";
import { sanitizeReturnPath } from "$lib/server/auth";
import { STEP_UP_WINDOW_MS } from "$lib/server/code/stepUp";

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
	handler: typeof forwarderGET | typeof forwarderDELETE,
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

async function createSession(deviceId: string): Promise<string> {
	const ws = await parse<{ workspace: { id: string } }>(
		await forwarder(forwarderPOST, `/api/v2/code/v1/workspaces?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ path: "/repo", title: "repo" }),
			locals: user.locals,
		})
	);
	const created = await parse<{ agent: { id: string } }>(
		await forwarder(forwarderPOST, `/api/v2/code/v1/agents?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ workspaceId: ws.workspace.id, provider: "opencode", posture: "plan" }),
			locals: user.locals,
		})
	);
	return created.agent.id;
}

const DAY = 24 * 3600 * 1000;
const SHA = "a".repeat(64);

/** One path per RULES entry (and then some). The first spec fails when an
 * entry of `_RULES` matches none of these, so a new forwarder route cannot be
 * added without a line here. */
const FORWARDER_SAMPLES: Array<[string, string]> = [
	["GET", "v1/workspaces"],
	["POST", "v1/workspaces"],
	["GET", "v1/workspaces/suggest"],
	["GET", "v1/workspaces/w1"],
	["POST", "v1/workspaces/w1/title"],
	["GET", "v1/workspaces/w1/agents"],
	["GET", "v1/workspaces/w1/files"],
	["GET", "v1/workspaces/w1/files/stat"],
	["GET", "v1/workspaces/w1/files/content"],
	["GET", "v1/workspaces/w1/files/raw"],
	["GET", "v1/workspaces/w1/files/status"],
	["GET", "v1/workspaces/w1/terminals"],
	["POST", "v1/workspaces/w1/terminals"],
	["POST", "v1/terminals/t1/name"],
	["POST", "v1/terminals/t1/ticket"],
	["DELETE", "v1/terminals/t1"],
	["GET", "v1/agents"],
	["POST", "v1/agents"],
	["GET", "v1/permissions/pending"],
	["GET", "v1/providers"],
	["GET", "v1/providers/opencode/modes"],
	["GET", "v1/providers/opencode/models"],
	["GET", "v1/providers/opencode/features"],
	["GET", "v1/agents/a1"],
	["DELETE", "v1/agents/a1"],
	["GET", `v1/agents/a1/attachments/${SHA}`],
	["GET", "v1/agents/a1/subagents"],
	["GET", "v1/agents/a1/subagents/s1/timeline"],
	["POST", "v1/agents/a1/messages"],
	["GET", "v1/agents/a1/commands"],
	["POST", "v1/agents/a1/command"],
	["POST", "v1/agents/a1/handoff"],
	["POST", "v1/agents/a1/permissions/p1"],
	["POST", "v1/agents/a1/questions/q1"],
	["POST", "v1/agents/a1/mode"],
	["POST", "v1/agents/a1/model"],
	["POST", "v1/agents/a1/feature"],
	["POST", "v1/agents/a1/cancel"],
	["POST", "v1/agents/a1/compact"],
	["POST", "v1/agents/a1/revert"],
	["POST", "v1/agents/a1/effort"],
	["POST", "v1/agents/a1/unrevert"],
	["POST", "v1/agents/a1/name"],
	["POST", "v1/agents/a1/archive"],
	["POST", "v1/workspaces/w1/archive"],
	["GET", "v1/agents/a1/diff"],
	["GET", "v1/agents/a1/permission-rules"],
	["POST", "v1/agents/a1/permission-rules"],
	["DELETE", "v1/agents/a1/permission-approvals/x1"],
];

/** The routes that are not the forwarder, plus a path no route has yet: the
 * prefix guard must refuse it all the same. */
const OTHER_SAMPLES: Array<[string, string]> = [
	["GET", "devices"],
	["PATCH", "devices?id=x"],
	["DELETE", "devices?id=x"],
	["GET", "agents/a1/stream?device=d1"],
	["GET", "attachments/k1"],
	["POST", "attachments/k1"],
	["GET", `attachments/k1/${SHA}`],
	// The machine link is a WebSocket upgrade that never reaches the hook; an
	// ordinary GET to its path is just another request under the prefix.
	["GET", "machine"],
	["GET", "some-route-nobody-has-written-yet"],
	["POST", "some/other/route"],
	["GET", ""],
];

/** Every `+server.ts` under api/v2/code. A new one fails the spec until it is
 * added here — and, if it is a person-facing route, to the samples above. */
const KNOWN_ROUTE_FILES = [
	"../[...path]/+server.ts",
	"../agents/[id]/stream/+server.ts",
	"../attachments/[key]/+server.ts",
	"../attachments/[key]/[sha256]/+server.ts",
	"../devices/+server.ts",
	"../status/+server.ts",
];

const reached = async () => new Response("reached", { status: 200 });

async function withAuthTime(authTime: Date | null): Promise<string> {
	const person = await createTestUser();
	if (authTime) {
		await collections.sessions.updateOne(
			{ sessionId: person.session.sessionId },
			{ $set: { authTime } }
		);
	}
	return person.cookie;
}

async function hit(method: string, path: string, cookie?: string): Promise<Response> {
	return testRequest(reached, {
		method,
		path: `/api/v2/code/${path}`,
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
		...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}),
	});
}

describe("the guard cannot be outrun by a new route", () => {
	it("has a sample path for every entry of the forwarder's allowlist", () => {
		const uncovered = _RULES
			.filter(
				(rule) => !FORWARDER_SAMPLES.some(([m, p]) => m === rule.method && rule.pattern.test(p))
			)
			.map((rule) => `${rule.method} ${rule.pattern}`);
		expect(uncovered, "RULES entries with no sample in FORWARDER_SAMPLES").toEqual([]);
	});

	it("knows every route file under api/v2/code", () => {
		const found = Object.keys(import.meta.glob("../**/+server.ts")).sort();
		expect(found, "a route file the guard spec has not been told about").toEqual(
			[...KNOWN_ROUTE_FILES].sort()
		);
	});
});

describe("a stale sign-in is refused everywhere under /api/v2/code", () => {
	const staleCases: Array<[string, () => Promise<string>]> = [
		["an authTime 8 days old", () => withAuthTime(new Date(Date.now() - 8 * DAY))],
		[
			"an authTime a minute past the window",
			() => withAuthTime(new Date(Date.now() - STEP_UP_WINDOW_MS - 60_000)),
		],
		["no authTime at all", () => withAuthTime(null)],
	];

	for (const [label, makeCookie] of staleCases) {
		it(`answers 401 reauth_required to every route with ${label}`, async () => {
			const cookie = await makeCookie();
			const failures: string[] = [];
			for (const [method, path] of [...FORWARDER_SAMPLES, ...OTHER_SAMPLES]) {
				const res = await hit(method, path, cookie);
				const code = res.status === 401 ? (await parse<{ code?: string }>(res)).code : undefined;
				if (res.status !== 401 || code !== "reauth_required") {
					failures.push(`${method} /${path} -> ${res.status} ${code ?? ""}`);
				}
			}
			expect(failures).toEqual([]);
		});
	}

	it("lets the same routes through once the sign-in is fresh, so the 401s above are the guard's", async () => {
		const cookie = await withAuthTime(new Date(Date.now() - 6 * DAY));
		for (const [method, path] of [
			["GET", "v1/agents"],
			["GET", "devices"],
			["GET", "some-route-nobody-has-written-yet"],
		]) {
			expect((await hit(method, path, cookie)).status, `${method} ${path}`).toBe(200);
		}
	});

	it("still answers 401 for a request with no session at all (the routes' own login check)", async () => {
		const forwarded = await forwarder(forwarderGET, "/api/v2/code/v1/agents", {
			locals: {} as App.Locals,
		});
		expect(forwarded.status).toBe(401);
		const devices = await testRequest(devicesGET, { path: "/api/v2/code/devices" });
		expect(devices.status).toBe(401);
	});

	it("does not touch routes outside the prefix", async () => {
		const cookie = await withAuthTime(null);
		const res = await testRequest(reached, {
			path: "/api/v2/feature-flags",
			headers: { cookie },
		});
		expect(res.status).toBe(200);
	});
});

describe("GET /api/v2/code/status", () => {
	async function status(cookie?: string) {
		const res = await testRequest(statusGET, {
			path: "/api/v2/code/status",
			headers: cookie ? { cookie } : {},
		});
		expect(res.status).toBe(200);
		return parse<Record<string, unknown>>(res);
	}

	it("is open to a stale session and says only that it is stale, and where to go", async () => {
		const body = await status(await withAuthTime(new Date(Date.now() - 9 * DAY)));
		expect(Object.keys(body).sort()).toEqual(["enabled", "fresh", "reauthPath"]);
		expect(body.fresh).toBe(false);
		expect(body.reauthPath).toBe("/login?reauth=1&next=/code");
		expect(sanitizeReturnPath(body.reauthPath as string)).toBe(body.reauthPath);
	});

	it("treats a session with no authTime as stale", async () => {
		expect((await status(await withAuthTime(null))).fresh).toBe(false);
	});

	it("says fresh, with when it stops being fresh, for a current sign-in", async () => {
		const authTime = new Date(Date.now() - 2 * DAY);
		const body = await status(await withAuthTime(authTime));
		expect(body.fresh).toBe(true);
		expect(Object.keys(body).sort()).toEqual(["enabled", "fresh", "freshUntil", "reauthPath"]);
		expect(body.freshUntil).toBe(new Date(authTime.getTime() + STEP_UP_WINDOW_MS).toISOString());
	});

	it("is not fresh for no session at all", async () => {
		expect((await status()).fresh).toBe(false);
	});

	it("carries nothing derived from a machine, even with one paired", async () => {
		const machine = await connectAndPair();
		const body = await status(await withAuthTime(new Date()));
		expect(JSON.stringify(body)).not.toContain(machine.deviceId as string);
		expect(Object.keys(body).sort()).toEqual(["enabled", "fresh", "freshUntil", "reauthPath"]);
		machine.close();
	});
});

describe("the event stream ends itself when the sign-in lapses", () => {
	async function openStream(authTime: Date, machine: FakeMachine) {
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		const controller = new AbortController();
		const res = await testRequest(streamGET, {
			path: `/api/v2/code/agents/${sessionId}/stream?device=${deviceId}`,
			params: { id: sessionId },
			locals: { ...user.locals, authTime },
			signal: controller.signal,
		});
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		if (!reader) throw new Error("no body");
		return { reader, controller };
	}

	async function readFrames(
		reader: ReadableStreamDefaultReader<Uint8Array>,
		until: (frames: string[]) => boolean,
		timeoutMs = 8000
	): Promise<{ frames: string[]; ended: boolean }> {
		const decoder = new TextDecoder();
		const frames: string[] = [];
		let buffer = "";
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) return { frames, ended: true };
			buffer += decoder.decode(value, { stream: true });
			let sep = buffer.indexOf("\n\n");
			while (sep !== -1) {
				const raw = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				if (!raw.startsWith(":")) frames.push(raw);
				sep = buffer.indexOf("\n\n");
			}
			if (until(frames)) return { frames, ended: false };
		}
		throw new Error("timed out");
	}

	it("sends one reauth_required frame at authTime + 7 days, then closes", async () => {
		const machine = await connectAndPair();
		// 7 days minus 400ms of life left: the schedule is the server's, set when
		// the stream opens, with no request from the page.
		const { reader } = await openStream(new Date(Date.now() - STEP_UP_WINDOW_MS + 400), machine);
		const { frames, ended } = await readFrames(reader, () => false).catch(async () => {
			throw new Error("stream did not end after the window lapsed");
		});
		expect(ended).toBe(true);
		const last = frames[frames.length - 1];
		expect(last).toContain("event: reauth_required");
		expect(last).toContain('"code":"reauth_required"');
		expect(frames.filter((f) => f.includes("reauth_required"))).toHaveLength(1);
		machine.close();
	});

	it("keeps streaming while the sign-in is fresh", async () => {
		const machine = await connectAndPair();
		const { reader, controller } = await openStream(new Date(), machine);
		const { frames } = await readFrames(reader, (f) => f.length >= 1);
		expect(frames.some((f) => f.includes("reauth_required"))).toBe(false);
		controller.abort();
		await reader.cancel().catch(() => {});
		machine.close();
	});
});
