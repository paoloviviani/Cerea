/**
 * The schedules API, through the real `handle` hook: who may call it, what a
 * stale sign-in can do (nothing — the /code guard covers the prefix), whose
 * rows a caller can see, and what a bad request is told. The machine behind
 * it is the shared fake (`tests/fake-machine.ts`) on a real socket.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import superjson from "superjson";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { acceptMachineConnection } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import "$lib/server/code/scheduleAgentExecutor";
import { FakeMachine } from "../../../../../../tests/fake-machine";
import { PATCH as devicesPATCH } from "../devices/+server";
import { GET as listGET, POST as listPOST } from "../schedules/+server";
import { DELETE as oneDELETE, GET as oneGET, PATCH as onePATCH } from "../schedules/[id]/+server";
import { POST as runPOST } from "../schedules/[id]/run/+server";
import { GET as runsGET } from "../schedules/[id]/runs/+server";
import { POST as previewPOST } from "../schedules/preview/+server";

const limits = vi.hoisted(() => ({ enabled: true }));
vi.mock("$lib/server/schedules/limits", async (original) => ({
	...(await original<typeof import("$lib/server/schedules/limits")>()),
	schedulesEnabled: () => limits.enabled,
}));

const DAY = 24 * 3600 * 1000;

let httpServer: Server;
let wss: WebSocketServer;
let port: number;
let principal: MachinePrincipal;
let person: Awaited<ReturnType<typeof createTestUser>>;
let machine: FakeMachine;
let deviceId: string;

beforeAll(async () => {
	await ready;
	wss = new WebSocketServer({ noServer: true });
	httpServer = createServer();
	httpServer.on("upgrade", (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => acceptMachineConnection(ws, req, principal, "t"));
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const address = httpServer.address();
	port = typeof address === "object" && address ? address.port : 0;
}, 30_000);

afterAll(async () => {
	wss.close();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** A signed-in person whose sign-in is `ageMs` old (`null`: no authTime at all). */
async function signedIn(ageMs: number | null) {
	const p = await createTestUser();
	if (ageMs !== null) {
		await collections.sessions.updateOne(
			{ sessionId: p.session.sessionId },
			{ $set: { authTime: new Date(Date.now() - ageMs) } }
		);
	}
	return p;
}

beforeEach(async () => {
	limits.enabled = true;
	person = await signedIn(1000);
	principal = {
		userId: person.user._id,
		sub: person.user.hfUserId,
		iss: "http://fake-issuer.invalid",
		exp: Math.floor(Date.now() / 1000) + 3600,
		machineId: randomUUID(),
		machineName: "build box",
	};
	machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
	const { deviceId: id } = await machine.hello();
	await testRequest(devicesPATCH, {
		method: "PATCH",
		path: `/api/v2/code/devices?id=${id}`,
		headers: { "content-type": "application/json", cookie: person.cookie },
		body: JSON.stringify({ action: "confirm" }),
	});
	await machine.waitForPaired();
	deviceId = id;
	machine.model.workspaces.push({
		id: "ws1",
		name: "repo",
		path: "/work/repo",
		createdAt: new Date().toISOString(),
		isGitRepo: true,
	});
});

afterEach(async () => {
	machine.close();
	await collections.schedules.deleteMany({});
	await collections.scheduleRuns.deleteMany({});
	await cleanupTestData();
});

const body = (over: Record<string, unknown> = {}) => ({
	name: "Nightly",
	prompt: "run the suite",
	recurrence: { type: "daily", at: "02:00" },
	timezone: "Europe/Rome",
	target: {
		deviceId,
		workspaceId: "ws1",
		sessionMode: "new",
		modeId: "build",
		permissionMode: "ask",
	},
	...over,
});

type Handler = Parameters<typeof testRequest>[0];

async function call(
	handler: Handler,
	path: string,
	options: {
		method?: string;
		json?: unknown;
		cookie?: string | null;
		params?: Record<string, string>;
		contentType?: string | null;
	} = {}
) {
	const cookie = options.cookie === undefined ? person.cookie : options.cookie;
	const contentType = options.contentType === undefined ? "application/json" : options.contentType;
	const res = await testRequest(handler, {
		method: options.method ?? "GET",
		path: `/api/v2/code/${path}`,
		headers: {
			...(contentType ? { "content-type": contentType } : {}),
			...(cookie ? { cookie } : {}),
		},
		...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
		...(options.params ? { params: options.params } : {}),
	});
	const text = await res.text();
	let data: Record<string, unknown> = {};
	try {
		data = text ? (superjson.parse(text) as Record<string, unknown>) : {};
	} catch {
		data = { raw: text };
	}
	return { status: res.status, data, text };
}

async function create(over: Record<string, unknown> = {}, cookie?: string) {
	const res = await call(listPOST, "schedules", { method: "POST", json: body(over), cookie });
	expect(res.status, JSON.stringify(res.data)).toBe(201);
	return res.data.schedule as { id: string; targetLabel: string; nextRunAt: Date };
}

const ROUTES: Array<[string, Handler, string, string, unknown?]> = [
	["list", listGET as Handler, "schedules", "GET"],
	["create", listPOST as Handler, "schedules", "POST", {}],
	["read", oneGET as Handler, "schedules/aaaaaaaaaaaaaaaaaaaaaaaa", "GET"],
	["edit", onePATCH as Handler, "schedules/aaaaaaaaaaaaaaaaaaaaaaaa", "PATCH", {}],
	["delete", oneDELETE as Handler, "schedules/aaaaaaaaaaaaaaaaaaaaaaaa", "DELETE"],
	["run now", runPOST as Handler, "schedules/aaaaaaaaaaaaaaaaaaaaaaaa/run", "POST", {}],
	["history", runsGET as Handler, "schedules/aaaaaaaaaaaaaaaaaaaaaaaa/runs", "GET"],
	["preview", previewPOST as Handler, "schedules/preview", "POST", {}],
];

describe("who may call it", () => {
	for (const [label, handler, path, method, json] of ROUTES) {
		it(`${label}: no sign-in is refused`, async () => {
			const res = await call(handler, path, {
				method,
				json,
				cookie: null,
				params: { id: "aaaaaaaaaaaaaaaaaaaaaaaa" },
			});
			expect(res.status).toBe(401);
		});
	}

	it("answers 404 when /code is on but scheduled actions are switched off", async () => {
		limits.enabled = false;
		for (const [label, handler, path, method, json] of ROUTES) {
			const res = await call(handler, path, {
				method,
				json,
				params: { id: "aaaaaaaaaaaaaaaaaaaaaaaa" },
			});
			expect(res.status, label).toBe(404);
		}
	});
});

describe("the stale-sign-in guard covers every route", () => {
	const stale: Array<[string, () => Promise<Awaited<ReturnType<typeof signedIn>>>]> = [
		["8 days old", () => signedIn(8 * DAY)],
		["with no authTime", () => signedIn(null)],
	];
	for (const [label, make] of stale) {
		it(`refuses create, edit, delete, run now, list, history and preview with a sign-in ${label}`, async () => {
			const mine = await create();
			const old = await make();
			// Same owner as the live schedule's, but a stale cookie: sign the stale
			// session into the schedule's owner so the only thing wrong is its age.
			await collections.sessions.updateOne(
				{ sessionId: old.session.sessionId },
				{ $set: { userId: person.user._id } }
			);
			const id = mine.id;
			const attempts: Array<[Handler, string, string, unknown]> = [
				[listPOST as Handler, "schedules", "POST", body({ name: "Sneaky" })],
				[onePATCH as Handler, `schedules/${id}`, "PATCH", { name: "Renamed" }],
				[oneDELETE as Handler, `schedules/${id}`, "DELETE", undefined],
				[runPOST as Handler, `schedules/${id}/run`, "POST", {}],
				[listGET as Handler, "schedules", "GET", undefined],
				[oneGET as Handler, `schedules/${id}`, "GET", undefined],
				[runsGET as Handler, `schedules/${id}/runs`, "GET", undefined],
				[previewPOST as Handler, "schedules/preview", "POST", { recurrence: {}, timezone: "UTC" }],
			];
			for (const [handler, path, method, json] of attempts) {
				const res = await call(handler, path, {
					method,
					json,
					cookie: old.cookie,
					params: { id },
				});
				expect(res.status, `${method} ${path}`).toBe(401);
				expect(res.data.code, `${method} ${path}`).toBe("reauth_required");
			}
			// And none of it happened.
			const rows = await collections.schedules.find({ userId: person.user._id }).toArray();
			expect(rows.map((r) => r.name)).toEqual(["Nightly"]);
			expect(await collections.scheduleRuns.countDocuments({})).toBe(0);
			expect(machine.opLog.filter((o) => o.op === "session.create")).toHaveLength(0);
		});
	}

	it("lets a fresh sign-in through", async () => {
		await create();
		expect((await call(listGET, "schedules")).status).toBe(200);
	});
});

describe("create, read, edit, run now, history, delete", () => {
	it("walks the whole life of a schedule", async () => {
		const made = await create();
		expect(made.targetLabel).toBe("build box › repo › new session");
		expect(made.nextRunAt.getTime()).toBeGreaterThan(Date.now());

		const list = await call(listGET, "schedules");
		expect(list.status).toBe(200);
		expect((list.data.schedules as unknown[]).length).toBe(1);
		expect(list.data.limit).toBe(20);

		const one = await call(oneGET, `schedules/${made.id}`, { params: { id: made.id } });
		expect((one.data.schedule as { name: string }).name).toBe("Nightly");

		const edited = await call(onePATCH, `schedules/${made.id}`, {
			method: "PATCH",
			params: { id: made.id },
			json: { name: "Weekly", recurrence: { type: "weekly", day: 1, at: "07:30" } },
		});
		expect(edited.status).toBe(200);
		expect(edited.data.schedule).toMatchObject({
			name: "Weekly",
			recurrence: { type: "weekly", day: 1, at: "07:30" },
		});

		const ran = await call(runPOST, `schedules/${made.id}/run`, {
			method: "POST",
			params: { id: made.id },
			json: {},
		});
		expect(ran.status).toBe(200);
		expect(ran.data.run).toMatchObject({ status: "sent", trigger: "manual" });
		expect(machine.opLog.filter((o) => o.op === "session.prompt")).toHaveLength(1);

		const history = await call(runsGET, `schedules/${made.id}/runs`, { params: { id: made.id } });
		const runs = history.data.runs as Array<{
			status: string;
			result?: { ids: { sessionId: string } };
		}>;
		expect(runs.map((r) => r.status)).toEqual(["sent"]);
		expect(runs[0].result?.ids.sessionId).toBe(machine.model.sessions[0].id);

		const gone = await call(oneDELETE, `schedules/${made.id}`, {
			method: "DELETE",
			params: { id: made.id },
		});
		expect(gone.status).toBe(200);
		expect((await call(oneGET, `schedules/${made.id}`, { params: { id: made.id } })).status).toBe(
			404
		);
	});

	it("previews the next three runs, or says why not", async () => {
		const ok = await call(previewPOST, "schedules/preview", {
			method: "POST",
			json: { recurrence: { type: "weekdays", at: "09:00" }, timezone: "Europe/Rome" },
		});
		expect(ok.data.ok).toBe(true);
		expect((ok.data.next as Date[]).length).toBe(3);
		expect(ok.data.description).toBe("Weekdays at 09:00");
		const bad = await call(previewPOST, "schedules/preview", {
			method: "POST",
			json: { recurrence: { type: "cron", expr: "*/5 * * * *" }, timezone: "UTC" },
		});
		expect(bad.data).toMatchObject({ ok: false });
		expect(String(bad.data.error)).toMatch(/15 minutes/);
	});
});

describe("whose schedules they are", () => {
	it("is a 404, never a 403, for another person's schedule on every route", async () => {
		const stranger = await signedIn(1000);
		const mine = await create();
		const id = mine.id;
		const tries: Array<[Handler, string, string, unknown]> = [
			[oneGET as Handler, `schedules/${id}`, "GET", undefined],
			[onePATCH as Handler, `schedules/${id}`, "PATCH", { name: "mine now" }],
			[oneDELETE as Handler, `schedules/${id}`, "DELETE", undefined],
			[runPOST as Handler, `schedules/${id}/run`, "POST", {}],
			[runsGET as Handler, `schedules/${id}/runs`, "GET", undefined],
		];
		for (const [handler, path, method, json] of tries) {
			const res = await call(handler, path, {
				method,
				json,
				cookie: stranger.cookie,
				params: { id },
			});
			expect(res.status, `${method} ${path}`).toBe(404);
		}
		const list = await call(listGET, "schedules", { cookie: stranger.cookie });
		expect(list.data.schedules).toEqual([]);
		expect(await collections.schedules.countDocuments({ _id: { $exists: true } })).toBe(1);
		expect(machine.opLog.filter((o) => o.op === "session.create")).toHaveLength(0);
	});

	it("refuses a target on a machine the caller does not own", async () => {
		const stranger = await signedIn(1000);
		const res = await call(listPOST, "schedules", {
			method: "POST",
			json: body(),
			cookie: stranger.cookie,
		});
		expect(res.status).toBe(400);
		expect(await collections.schedules.countDocuments({ userId: stranger.user._id })).toBe(0);
	});
});

describe("what a bad request is told", () => {
	const bad: Array<[string, Record<string, unknown>, RegExp]> = [
		[
			"a cron faster than 15 minutes",
			{ recurrence: { type: "cron", expr: "*/10 * * * *" } },
			/15 minutes/,
		],
		["an unknown timezone", { timezone: "Mars/Base" }, /timezone/],
		["no name", { name: " " }, /name/],
		["no prompt", { prompt: "" }, /prompt/],
		[
			"a workspace the machine lacks",
			{ target: { ...body().target, workspaceId: "gone" } },
			/workspace/,
		],
		["an unknown kind", { kind: "chat" }, /Nothing here can run/],
	];
	for (const [label, over, message] of bad) {
		it(`explains ${label}`, async () => {
			const res = await call(listPOST, "schedules", { method: "POST", json: body(over) });
			expect(res.status).toBe(400);
			expect(res.text).toMatch(message);
		});
	}

	it("wants JSON", async () => {
		const res = await call(listPOST, "schedules", {
			method: "POST",
			json: body(),
			contentType: "text/plain",
		});
		// Refused before the handler (the hook's CSRF rule for a non-JSON post) or by it.
		expect([400, 403]).toContain(res.status);
		expect(await collections.schedules.countDocuments({})).toBe(0);
	});

	it("refuses an unreadable body", async () => {
		const junk = await testRequest(listPOST, {
			method: "POST",
			path: "/api/v2/code/schedules",
			headers: { "content-type": "application/json", cookie: person.cookie },
			body: "{not json",
		});
		expect(junk.status).toBe(400);
	});
});
