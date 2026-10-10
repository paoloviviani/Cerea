/**
 * Machine→Cerea `call` frames for schedules (PROTOCOL.md §5), against the
 * fake machine over a real WebSocket and the real link: what an agent may do
 * to its owner's schedules, and every refusal, read off the `callres`.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { acceptMachineConnection } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { PATCH as devicesPATCH } from "../../../routes/api/v2/code/devices/+server";
import { FakeMachine } from "../../../../tests/fake-machine";
import { createSchedule, getSchedule } from "$lib/server/schedules/store";
import type { CallResFrame, Session } from "$lib/types/machineProtocol";
import { MAX_ACTIVE_AGENT_SCHEDULES, MAX_CALLS_PER_HOUR } from "./machineCalls";

const flags = vi.hoisted(() => ({ schedules: true }));
vi.mock("$lib/server/codeEnabled", async (original) => ({
	...(await original<typeof import("$lib/server/codeEnabled")>()),
	codeAgentsEnabled: () => true,
	codeSchedulesEnabled: () => flags.schedules,
}));

let httpServer: Server;
let wss: WebSocketServer;
let port: number;
let principal: MachinePrincipal;
let person: Awaited<ReturnType<typeof createTestUser>>;
let machine: FakeMachine;
let deviceId: string;
let session: Session;
const machines: FakeMachine[] = [];

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

async function connect(pair = true): Promise<FakeMachine> {
	const m = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
	machines.push(m);
	const { deviceId: id } = await m.hello();
	if (pair) {
		const res = await testRequest(devicesPATCH, {
			method: "PATCH",
			path: `/api/v2/code/devices?id=${id}`,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "confirm" }),
			locals: person.locals,
		});
		expect(res.status).toBe(200);
		await m.waitForPaired();
	}
	m.model.workspaces.push({
		id: "ws1",
		name: "repo",
		path: "/work/repo",
		createdAt: new Date().toISOString(),
		isGitRepo: true,
	});
	return m;
}

function addSession(m: FakeMachine, over: Partial<Session> = {}): Session {
	const now = new Date().toISOString();
	const s: Session = {
		id: `ses_${randomUUID().slice(0, 8)}`,
		workspaceId: "ws1",
		backend: "opencode",
		title: "Refactor the parser",
		status: "busy",
		pendingPermissions: 0,
		modeId: "build",
		modelId: null,
		permissionMode: "allow",
		parentId: null,
		createdAt: now,
		updatedAt: now,
		usage: null,
		...over,
	};
	m.model.sessions.push(s);
	return s;
}

const createArgs = (over: Record<string, unknown> = {}) => ({
	name: "Check CI",
	prompt: "See whether CI is green and fix it if not.",
	recurrence: { type: "daily", at: "08:00" },
	session: "new",
	permissionMode: "ask",
	...over,
});

function ok(res: CallResFrame): Record<string, unknown> {
	if (!res.ok) throw new Error(`expected ok, got ${res.error.code}: ${res.error.message}`);
	return res.result as Record<string, unknown>;
}

function refused(res: CallResFrame, code: string, text?: RegExp) {
	expect(res.ok).toBe(false);
	if (res.ok) return;
	expect(res.error.code).toBe(code);
	if (text) expect(res.error.message).toMatch(text);
}

async function createViaCall(over: Record<string, unknown> = {}, options = {}) {
	const result = ok(await machine.call("schedule.create", createArgs(over), options));
	return result.schedule as Record<string, unknown> & { id: string };
}

/** A schedule the person made in the editor, on `device`. */
async function personSchedule(device: string, over: Record<string, unknown> = {}) {
	return createSchedule(person.user._id, {
		name: "Person's nightly",
		prompt: "run the suite",
		recurrence: { type: "daily", at: "02:00" },
		timezone: "Europe/Rome",
		target: {
			deviceId: device,
			workspaceId: "ws1",
			sessionMode: "new",
			permissionMode: "allow",
		},
		...over,
	});
}

beforeEach(async () => {
	flags.schedules = true;
	person = await createTestUser();
	principal = {
		userId: person.user._id,
		sub: person.user.hfUserId,
		iss: "http://fake-issuer.invalid",
		exp: Math.floor(Date.now() / 1000) + 3600,
		machineId: randomUUID(),
		machineName: "build box",
	};
	machine = await connect();
	deviceId = machine.deviceId as string;
	session = addSession(machine);
});

afterEach(async () => {
	for (const m of machines.splice(0)) m.close();
	await collections.schedules.deleteMany({});
	await collections.scheduleRuns.deleteMany({});
	await collections.codeAudit.deleteMany({});
	await cleanupTestData();
});

describe("the link", () => {
	it("advertises schedule calls in the welcome", () => {
		expect(machine.features).toEqual({ machineCalls: ["schedule"] });
	});

	it("keeps the scheduleTools capability from the hello", async () => {
		const m = new FakeMachine(
			`ws://127.0.0.1:${port}/api/v2/code/machine`,
			{},
			{
				backends: [
					{
						id: "opencode",
						version: "1",
						capabilities: {
							diff: true,
							children: true,
							usage: true,
							compact: true,
							images: true,
							files: true,
							worktrees: false,
							questions: true,
							scheduleTools: true,
						},
					},
				],
			}
		);
		machines.push(m);
		const { deviceId: id } = await m.hello();
		const row = await collections.codeDevices.findOne({ _id: new ObjectId(id) });
		expect(row?.backends?.[0]?.capabilities.scheduleTools).toBe(true);
	});

	it("answers an unknown op unsupported", async () => {
		refused(await machine.call("schedule.explode"), "unsupported");
		refused(await machine.call("files.write"), "unsupported");
	});

	it("answers a malformed call invalid rather than leaving it to time out", async () => {
		const res = await new Promise<CallResFrame>((resolve) => {
			machine.ws.on("message", (raw: Buffer | string) => {
				const frame = JSON.parse(raw.toString()) as CallResFrame;
				if (frame.type === "callres" && frame.id === "bad-1") resolve(frame);
			});
			machine.ws.send(JSON.stringify({ type: "call", id: "bad-1", op: "schedule.list" }));
		});
		refused(res, "invalid");
	});

	it("refuses a machine that is not paired yet", async () => {
		principal = { ...principal, machineId: randomUUID() };
		const pending = await connect(false);
		refused(await pending.call("schedule.list"), "forbidden", /not paired/);
	});
});

describe("schedule.create", () => {
	it("creates a schedule on the calling machine, recorded as the agent's", async () => {
		const item = await createViaCall(
			{ coordination: ["session_spawn"] },
			{
				caller: { coordination: ["session_spawn"] },
			}
		);
		expect(item).toMatchObject({
			name: "Check CI",
			prompt: "See whether CI is green and fix it if not.",
			recurrenceText: expect.stringContaining("08:00"),
			timezone: "UTC",
			paused: false,
			status: "active",
			workspace: { id: "ws1", name: "repo" },
			session: "new",
			permissionMode: "ask",
			agentMode: "build",
			coordination: ["session_spawn"],
			createdBy: { kind: "agent", sessionId: session.id, title: "Refactor the parser" },
			self: false,
		});
		expect(typeof item.nextRunAt).toBe("string");
		const row = await getSchedule(person.user._id, item.id);
		expect(row.target).toMatchObject({
			deviceId,
			workspaceId: "ws1",
			sessionMode: "new",
			modeId: "build",
			permissionMode: "ask",
			canSpawn: true,
			labels: { machine: "build box", workspace: "repo" },
		});
		expect(row.createdBy).toEqual({
			kind: "agent",
			deviceId,
			workspaceId: "ws1",
			sessionId: session.id,
			title: "Refactor the parser",
		});
		const audit = await collections.codeAudit.findOne({ action: "schedule.create" });
		expect(audit).toMatchObject({
			deviceId: new ObjectId(deviceId),
			sessionId: session.id,
			origin: "agent",
			outcome: "ok",
			scheduleId: item.id,
			name: "Check CI",
		});
	});

	it("takes an agent mode, build by default, not bounded by the caller", async () => {
		const plan = await createViaCall(
			{ agentMode: "plan", permissionMode: "deny" },
			{ caller: { permissionMode: "deny" } }
		);
		expect(plan.agentMode).toBe("plan");
		expect((await getSchedule(person.user._id, plan.id)).target.modeId).toBe("plan");
		refused(
			await machine.call("schedule.create", createArgs({ agentMode: "yolo" })),
			"invalid",
			/agentMode/
		);
		// Update: a Deny session may switch an Allow schedule to build.
		const theirs = await personSchedule(deviceId);
		const res = ok(
			await machine.call(
				"schedule.update",
				{ id: theirs._id.toString(), agentMode: "build" },
				{ caller: { permissionMode: "deny" } }
			)
		);
		expect(res.schedule).toMatchObject({ agentMode: "build", permissionMode: "allow" });
		refused(
			await machine.call("schedule.update", { id: theirs._id.toString(), agentMode: "edit" }),
			"invalid"
		);
	});

	it("defaults the timezone to the person's own, and takes an explicit one", async () => {
		await personSchedule(deviceId);
		expect((await createViaCall()).timezone).toBe("Europe/Rome");
		expect((await createViaCall({ timezone: "Asia/Tokyo" })).timezone).toBe("Asia/Tokyo");
	});

	it("takes a stopping criterion, and refuses an invalid one", async () => {
		refused(await machine.call("schedule.create", createArgs({ maxOccurrences: 0 })), "invalid");
		refused(
			await machine.call("schedule.create", createArgs({ maxOccurrences: "3" })),
			"invalid",
			/maxOccurrences/
		);
		const item = await createViaCall({ maxOccurrences: 3 });
		const row = await getSchedule(person.user._id, item.id);
		expect(row.maxOccurrences).toBe(3);
		expect(row.firedCount).toBe(0);
	});

	it('session "this" pins the caller\'s root session', async () => {
		const child = addSession(machine, { parentId: session.id, title: "sub" });
		const item = await createViaCall(
			{ session: "this" },
			{ sessionId: child.id, rootSessionId: session.id }
		);
		expect(item.session).toBe(session.id);
		const row = await getSchedule(person.user._id, item.id);
		expect(row.target).toMatchObject({ sessionMode: "existing", sessionId: session.id });
		expect(row.createdBy).toMatchObject({ sessionId: child.id, title: "sub" });
	});

	it("keeps the store's own rules: the 15-minute floor, a known zone, a name", async () => {
		refused(
			await machine.call(
				"schedule.create",
				createArgs({ recurrence: { type: "cron", expr: "*/5 * * * *" } })
			),
			"invalid",
			/15 minutes/
		);
		refused(
			await machine.call("schedule.create", createArgs({ timezone: "Mars/Base" })),
			"invalid",
			/timezone/
		);
		refused(await machine.call("schedule.create", createArgs({ name: " " })), "invalid", /name/);
		refused(await machine.call("schedule.create", { name: "x" }), "invalid");
	});

	it("refuses a looser permission mode than the caller's", async () => {
		refused(
			await machine.call("schedule.create", createArgs({ permissionMode: "allow" }), {
				caller: { permissionMode: "ask" },
			}),
			"forbidden",
			/looser/
		);
		refused(
			await machine.call("schedule.create", createArgs({ permissionMode: "ask" }), {
				caller: { permissionMode: "deny" },
			}),
			"forbidden"
		);
		await createViaCall({ permissionMode: "deny" }, { caller: { permissionMode: "ask" } });
	});

	it("refuses coordination the caller does not have, or half the messaging group", async () => {
		refused(
			await machine.call("schedule.create", createArgs({ coordination: ["session_spawn"] })),
			"forbidden",
			/session_spawn/
		);
		refused(
			await machine.call("schedule.create", createArgs({ coordination: ["session_list"] }), {
				caller: { coordination: ["session_list"] },
			}),
			"invalid",
			/two groups/
		);
		const all = ["session_list", "session_read", "session_send"];
		const item = await createViaCall({ coordination: all }, { caller: { coordination: all } });
		expect(item.coordination).toEqual(all);
	});

	it("refuses a workspace that is not on this machine", async () => {
		refused(
			await machine.call("schedule.create", createArgs({ workspaceId: "elsewhere" })),
			"invalid",
			/not on this machine/
		);
	});

	it(`allows at most ${MAX_ACTIVE_AGENT_SCHEDULES} running agent-made schedules per machine`, async () => {
		const made = [];
		for (let i = 0; i < MAX_ACTIVE_AGENT_SCHEDULES; i++) made.push(await createViaCall());
		// The person's own schedules do not count.
		await personSchedule(deviceId);
		refused(await machine.call("schedule.create", createArgs()), "limit", /running schedules/);
		// A paused one does not count either.
		ok(await machine.call("schedule.update", { id: made[0].id, paused: true }));
		await createViaCall();
		// …and switching it back on would make six.
		refused(
			await machine.call("schedule.update", { id: made[0].id, paused: false }),
			"limit",
			/running schedules/
		);
	});

	it(`allows at most ${MAX_CALLS_PER_HOUR} changes per machine per hour, but always lets it stop`, async () => {
		const item = await createViaCall();
		for (let i = 1; i < MAX_CALLS_PER_HOUR; i++) {
			ok(await machine.call("schedule.update", { id: item.id, name: `Check CI ${i}` }));
		}
		refused(await machine.call("schedule.create", createArgs()), "limit", /last hour/);
		refused(await machine.call("schedule.update", { id: item.id, name: "again" }), "limit");
		const refusal = await collections.codeAudit.findOne({ action: "schedule.create.refused" });
		expect(refusal).toMatchObject({ outcome: "limit", sessionId: session.id });
		// Pausing and deleting are never refused by the rate limit.
		ok(await machine.call("schedule.update", { id: item.id, paused: true }));
		ok(await machine.call("schedule.delete", { id: item.id }));
	});

	it("is refused while the kill switch is off; context still answers", async () => {
		flags.schedules = false;
		refused(await machine.call("schedule.create", createArgs()), "unavailable", /switched off/);
		refused(await machine.call("schedule.list"), "unavailable");
		expect(ok(await machine.call("schedule.context"))).toEqual({
			scheduledRunOf: null,
			enabled: false,
		});
		expect(await collections.schedules.countDocuments({})).toBe(0);
	});
});

describe("schedule.list, update and delete", () => {
	let otherDeviceId: string;

	beforeEach(async () => {
		principal = { ...principal, machineId: randomUUID(), machineName: "laptop" };
		const other = await connect();
		otherDeviceId = other.deviceId as string;
	});

	it("lists only this machine's schedules, with who made them", async () => {
		await personSchedule(deviceId);
		await personSchedule(otherDeviceId, { name: "On the laptop" });
		await createViaCall();
		const { schedules } = ok(await machine.call("schedule.list")) as {
			schedules: Array<Record<string, unknown>>;
		};
		expect(schedules.map((s) => s.name)).toEqual(["Person's nightly", "Check CI"]);
		expect(schedules[0]).toMatchObject({
			createdBy: { kind: "person" },
			permissionMode: "allow",
			coordination: [],
			lastRunAt: null,
			self: false,
		});
		expect(schedules[1].createdBy).toMatchObject({ kind: "agent", sessionId: session.id });
	});

	it("updates the timetable and pauses", async () => {
		const item = await createViaCall();
		const res = ok(
			await machine.call("schedule.update", {
				id: item.id,
				recurrence: { type: "weekdays", at: "07:30" },
				paused: true,
			})
		);
		expect(res.schedule).toMatchObject({ paused: true, status: "paused", nextRunAt: null });
		const row = await getSchedule(person.user._id, item.id);
		expect(row.recurrence).toEqual({ type: "weekdays", at: "07:30" });
		expect(row.enabled).toBe(false);
		expect(await collections.codeAudit.countDocuments({ action: "schedule.update" })).toBe(1);
	});

	it("updates and clears the stopping criterion", async () => {
		const item = await createViaCall({ maxOccurrences: 3 });
		const id = item.id;
		ok(await machine.call("schedule.update", { id, maxOccurrences: 10 }));
		expect((await getSchedule(person.user._id, id)).maxOccurrences).toBe(10);
		refused(await machine.call("schedule.update", { id, maxOccurrences: 0 }), "invalid");
		ok(await machine.call("schedule.update", { id, maxOccurrences: null }));
		expect((await getSchedule(person.user._id, id)).maxOccurrences).toBeUndefined();
	});

	it("refuses to loosen a schedule, or hand over a looser one, past the caller", async () => {
		const item = await createViaCall({ permissionMode: "ask" });
		refused(
			await machine.call(
				"schedule.update",
				{ id: item.id, permissionMode: "allow" },
				{ caller: { permissionMode: "ask" } }
			),
			"forbidden"
		);
		refused(
			await machine.call(
				"schedule.update",
				{ id: item.id, coordination: ["session_spawn"] },
				{ caller: { coordination: [] } }
			),
			"forbidden"
		);
		// The person's Allow schedule: an Ask agent may rename it, not rewrite its prompt.
		const theirs = await personSchedule(deviceId);
		const id = theirs._id.toString();
		const asAsk = { caller: { permissionMode: "ask" as const } };
		ok(await machine.call("schedule.update", { id, name: "Renamed" }, asAsk));
		refused(await machine.call("schedule.update", { id, prompt: "rm -rf" }, asAsk), "forbidden");
		expect((await getSchedule(person.user._id, id)).prompt).toBe("run the suite");
	});

	it("cannot touch another machine's schedule", async () => {
		const theirs = await personSchedule(otherDeviceId);
		const id = theirs._id.toString();
		refused(await machine.call("schedule.update", { id, paused: true }), "not_found");
		refused(await machine.call("schedule.delete", { id }), "not_found");
		refused(await machine.call("schedule.delete", { id: "nope" }), "not_found");
		expect((await getSchedule(person.user._id, id)).enabled).toBe(true);
	});

	it("deletes this machine's schedule and audits it", async () => {
		const item = await createViaCall();
		expect(ok(await machine.call("schedule.delete", { id: item.id }))).toEqual({});
		expect(await collections.schedules.countDocuments({})).toBe(0);
		expect(
			await collections.codeAudit.findOne({ action: "schedule.delete", scheduleId: item.id })
		).toMatchObject({ name: "Check CI", outcome: "ok" });
	});
});

describe("schedule.context and self", () => {
	async function recordRun(scheduleId: ObjectId, sessionId: string, device = deviceId) {
		await collections.scheduleRuns.insertOne({
			_id: new ObjectId(),
			scheduleId,
			userId: person.user._id,
			kind: "agent",
			scheduledFor: new Date(),
			firedAt: new Date(),
			status: "sent",
			trigger: "schedule",
			scheduleName: "x",
			result: { type: "agent-session", ids: { deviceId: device, workspaceId: "ws1", sessionId } },
		});
	}

	it("says whether the caller's session (or its root) is a scheduled run", async () => {
		expect(ok(await machine.call("schedule.context"))).toEqual({
			scheduledRunOf: null,
			enabled: true,
		});
		const theirs = await personSchedule(deviceId);
		await recordRun(theirs._id, session.id);
		expect(ok(await machine.call("schedule.context"))).toEqual({
			scheduledRunOf: theirs._id.toString(),
			enabled: true,
		});
		// A subagent of that run: found through its root.
		const child = addSession(machine, { parentId: session.id });
		expect(
			ok(
				await machine.call(
					"schedule.context",
					{},
					{ sessionId: child.id, rootSessionId: session.id }
				)
			).scheduledRunOf
		).toBe(theirs._id.toString());
		// The same session id on another machine is not this one.
		const other = addSession(machine);
		await recordRun(theirs._id, other.id, new ObjectId().toHexString());
		expect(
			ok(await machine.call("schedule.context", {}, { sessionId: other.id })).scheduledRunOf
		).toBe(null);
	});

	it("marks the schedule whose run the caller is as self in the list", async () => {
		const mine = await personSchedule(deviceId, { name: "Mine" });
		await personSchedule(deviceId, { name: "Not mine" });
		await recordRun(mine._id, session.id);
		const { schedules } = ok(await machine.call("schedule.list")) as {
			schedules: Array<{ name: string; self: boolean }>;
		};
		expect(schedules.map((s) => [s.name, s.self])).toEqual([
			["Mine", true],
			["Not mine", false],
		]);
		// And it may pause itself.
		const res = ok(
			await machine.call("schedule.update", { id: mine._id.toString(), paused: true })
		);
		expect(res.schedule).toMatchObject({ self: true, paused: true });
	});
});
