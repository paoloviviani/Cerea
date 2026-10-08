/**
 * The "agent" executor against the fake machine the /code specs share
 * (`tests/fake-machine.ts`) over a real WebSocket and the real `MachineLink`:
 * what a run does is read off the ops the machine received (`opLog`), which
 * is exactly the contract with galopin — no op beyond the panel's own.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { OpError } from "$lib/types/machineProtocol";
import { acceptMachineConnection, isMachineOnline } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import {
	PATCH as devicesPATCH,
	DELETE as devicesDELETE,
} from "../../../routes/api/v2/code/devices/+server";
import { FakeMachine, type FakeMachineOptions } from "../../../../tests/fake-machine";
import { getExecutor } from "$lib/server/schedules/executors";
import { runNow } from "$lib/server/schedules/scheduler";
import { createSchedule, getSchedule, listRuns } from "$lib/server/schedules/store";
import { runStamp } from "./scheduleAgentExecutor";
import type { Schedule } from "$lib/types/Schedule";

const flags = vi.hoisted(() => ({ codeAgents: true }));
vi.mock("$lib/server/codeEnabled", async (original) => ({
	...(await original<typeof import("$lib/server/codeEnabled")>()),
	codeAgentsEnabled: () => flags.codeAgents,
}));

let httpServer: Server;
let wss: WebSocketServer;
let port: number;
let principal: MachinePrincipal;
let person: Awaited<ReturnType<typeof createTestUser>>;
let machine: FakeMachine;
let deviceId: string;
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

async function connectAndPair(options: FakeMachineOptions = {}): Promise<FakeMachine> {
	const m = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {}, options);
	machines.push(m);
	const { deviceId: id } = await m.hello();
	const res = await testRequest(devicesPATCH, {
		method: "PATCH",
		path: `/api/v2/code/devices?id=${id}`,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: "confirm" }),
		locals: person.locals,
	});
	expect(res.status).toBe(200);
	await m.waitForPaired();
	return m;
}

function addWorkspace(m: FakeMachine, id = "ws1", name = "repo") {
	m.model.workspaces.push({
		id,
		name,
		path: `/work/${name}`,
		createdAt: new Date().toISOString(),
		isGitRepo: true,
	});
}

const target = (over: Record<string, unknown> = {}) => ({
	deviceId,
	workspaceId: "ws1",
	sessionMode: "new",
	modeId: "build",
	modelId: "pystino/mock-model",
	permissionMode: "allow",
	...over,
});

async function make(over: Record<string, unknown> = {}, targetOver: Record<string, unknown> = {}) {
	return createSchedule(person.user._id, {
		name: "Nightly",
		prompt: "run the suite",
		recurrence: { type: "daily", at: "02:00" },
		timezone: "Europe/Rome",
		target: target(targetOver),
		...over,
	});
}

const ops = (name: string) => machine.opLog.filter((o) => o.op === name);

beforeEach(async () => {
	flags.codeAgents = true;
	person = await createTestUser();
	principal = {
		userId: person.user._id,
		sub: person.user.hfUserId,
		iss: "http://fake-issuer.invalid",
		exp: Math.floor(Date.now() / 1000) + 3600,
		machineId: randomUUID(),
		machineName: "build box",
	};
	machine = await connectAndPair();
	deviceId = machine.deviceId as string;
	addWorkspace(machine);
	// The fake answers an unknown session with a generic error; galopin answers
	// not_found (PROTOCOL.md §6), which is what the executor reads.
	machine.onOp<{ sessionId: string }>("session.get", ({ sessionId }) => {
		const session = machine.model.sessions.find((s) => s.id === sessionId);
		if (!session) throw new OpError("not_found", `no such session ${sessionId}`);
		return { session: { ...session } };
	});
});

afterEach(async () => {
	for (const m of machines.splice(0)) m.close();
	await collections.schedules.deleteMany({});
	await collections.scheduleRuns.deleteMany({});
	await cleanupTestData();
});

describe("validateTarget", () => {
	it("takes the machine's own names, and describes the target machine › workspace › session", async () => {
		const row = await make();
		expect(row.target).toMatchObject({
			deviceId,
			workspaceId: "ws1",
			labels: { machine: "build box", workspace: "repo" },
		});
		expect(await getExecutor("agent")?.describeTarget(row.target, { userId: row.userId })).toBe(
			"build box › repo › new session"
		);
	});

	it("names an existing session by its title", async () => {
		const { session } =
			(await machine.model.sessions.push(sessionRow("s1", "ws1", "Fix flaky test")),
			{ session: null });
		void session;
		const row = await make({}, { sessionMode: "existing", sessionId: "s1" });
		expect(await getExecutor("agent")?.describeTarget(row.target, { userId: row.userId })).toBe(
			"build box › repo › Fix flaky test"
		);
	});

	it("refuses a machine that is not the caller's, as though it did not exist", async () => {
		const stranger = await createTestUser();
		await expect(
			createSchedule(stranger.user._id, {
				name: "x",
				prompt: "p",
				recurrence: { type: "daily", at: "02:00" },
				timezone: "UTC",
				target: target(),
			})
		).rejects.toMatchObject({ status: 400, message: "That machine is not one of yours." });
		await expect(make({}, { deviceId: "not-an-id" })).rejects.toMatchObject({ status: 400 });
	});

	it("refuses a workspace the machine does not have, and a session of another workspace", async () => {
		await expect(make({}, { workspaceId: "nope" })).rejects.toMatchObject({
			message: "That workspace is not on this machine.",
		});
		addWorkspace(machine, "ws2", "other");
		machine.model.sessions.push(sessionRow("s2", "ws2", "elsewhere"));
		await expect(make({}, { sessionMode: "existing", sessionId: "s2" })).rejects.toMatchObject({
			message: "That session is not a session of this workspace.",
		});
		await expect(make({}, { sessionMode: "existing", sessionId: "ghost" })).rejects.toMatchObject({
			message: "That session is not on this machine.",
		});
	});

	it("refuses a session choice that contradicts itself, and a non-gateway model", async () => {
		await expect(make({}, { sessionMode: "existing" })).rejects.toMatchObject({ status: 400 });
		await expect(make({}, { sessionMode: "new", sessionId: "s1" })).rejects.toMatchObject({
			status: 400,
		});
		await expect(make({}, { modelId: "opencode/free" })).rejects.toMatchObject({
			message: "This machine was enrolled without --allow-free-models.",
		});
		await expect(make({}, { permissionMode: "yolo" })).rejects.toMatchObject({ status: 400 });
	});

	it("accepts an offline machine, with the names the editor gave", async () => {
		machine.close();
		await vi.waitFor(() => expect(isMachineOnline(deviceId)).toBe(false));
		const row = await make({}, { labels: { workspace: "repo (last seen)" } });
		expect(row.target).toMatchObject({
			labels: { machine: "build box", workspace: "repo (last seen)" },
		});
	});
});

describe("a new session each run", () => {
	it("creates a titled session with the mode and model, sets the permission mode, then sends the prompt", async () => {
		const row = await make();
		const run = await runNow(person.user._id, row._id.toString());
		expect(run.status).toBe("sent");

		const [create] = ops("session.create");
		expect(create.args).toMatchObject({
			workspaceId: "ws1",
			modeId: "build",
			modelId: "pystino/mock-model",
		});
		const title = (create.args as { title: string }).title;
		expect(title).toBe(`Nightly · ${runStamp(run.firedAt, "Europe/Rome")}`);
		expect(title).toMatch(/^Nightly · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

		const session = machine.model.sessions[0];
		expect(session.permissionMode).toBe("allow");
		expect(ops("session.setPermissionMode")[0].args).toEqual({
			sessionId: session.id,
			mode: "allow",
		});
		expect(ops("session.prompt")[0].args).toMatchObject({
			sessionId: session.id,
			text: "run the suite",
		});
		// The word is in force before the first word reaches the agent.
		const order = machine.opLog.map((o) => o.op);
		expect(order.indexOf("session.setPermissionMode")).toBeLessThan(
			order.indexOf("session.prompt")
		);
		expect(run.result).toMatchObject({
			type: "agent-session",
			ids: { deviceId, workspaceId: "ws1", sessionId: session.id },
		});
	});

	it("applies Deny and Ask as chosen, and leaves a new session's Ask alone", async () => {
		const deny = await make({}, { permissionMode: "deny" });
		await runNow(person.user._id, deny._id.toString());
		expect(machine.model.sessions[0].permissionMode).toBe("deny");
		machine.opLog.length = 0;
		const ask = await make({ name: "Asker" }, { permissionMode: "ask" });
		await runNow(person.user._id, ask._id.toString());
		expect(machine.model.sessions[1].permissionMode).toBe("ask");
		expect(ops("session.setPermissionMode")).toHaveLength(0);
	});

	it("starts the next run in a session of its own once the last one is idle", async () => {
		const row = await make();
		await runNow(person.user._id, row._id.toString());
		await runNow(person.user._id, row._id.toString());
		expect(machine.model.sessions).toHaveLength(2);
		expect(new Set(machine.model.sessions.map((s) => s.id)).size).toBe(2);
	});

	it("falls back to the panel's own default mode when none was chosen", async () => {
		const row = await make({}, { modeId: undefined, modelId: undefined });
		await runNow(person.user._id, row._id.toString());
		expect(ops("session.create")[0].args).toMatchObject({ modeId: "plan" });
		expect(ops("session.create")[0].args).not.toHaveProperty("modelId");
	});

	it("skips while the previous run's session is still working, creating nothing", async () => {
		const row = await make();
		await runNow(person.user._id, row._id.toString());
		machine.model.sessions[0].status = "busy";
		machine.opLog.length = 0;
		const run = await runNow(person.user._id, row._id.toString());
		expect(run.status).toBe("skipped-still-running");
		expect(run.detail).toMatch(/still working/);
		expect(ops("session.create")).toHaveLength(0);
		expect(ops("session.prompt")).toHaveLength(0);
		// A skipped run is not a failure.
		expect((await getSchedule(person.user._id, row._id.toString())).consecutiveFailures).toBe(0);
	});

	it("skips while the previous run is waiting on an approval (Ask stalls here)", async () => {
		const row = await make({}, { permissionMode: "ask" });
		await runNow(person.user._id, row._id.toString());
		Object.assign(machine.model.sessions[0], { pendingPermissions: 1 });
		const run = await runNow(person.user._id, row._id.toString());
		expect(run.status).toBe("skipped-still-running");
		expect(run.detail).toMatch(/waiting for an approval/);
	});

	it("carries on when the previous run's session has since been deleted", async () => {
		const row = await make();
		await runNow(person.user._id, row._id.toString());
		machine.model.sessions.length = 0;
		const run = await runNow(person.user._id, row._id.toString());
		expect(run.status).toBe("sent");
	});
});

describe("always this session", () => {
	beforeEach(() => {
		machine.model.sessions.push({
			...sessionRow("s1", "ws1", "Long-running"),
			modeId: "plan",
			modelId: "opencode/coder",
		});
	});

	it("prompts the pinned session without creating one, setting mode, model and permission mode", async () => {
		const row = await make({}, { sessionMode: "existing", sessionId: "s1" });
		const run = await runNow(person.user._id, row._id.toString());
		expect(run.status).toBe("sent");
		expect(ops("session.create")).toHaveLength(0);
		expect(ops("session.setMode")[0].args).toEqual({ sessionId: "s1", modeId: "build" });
		expect(ops("session.setModel")[0].args).toEqual({
			sessionId: "s1",
			modelId: "pystino/mock-model",
		});
		expect(ops("session.setPermissionMode")[0].args).toEqual({ sessionId: "s1", mode: "allow" });
		expect(ops("session.prompt")[0].args).toMatchObject({ sessionId: "s1", text: "run the suite" });
		expect(machine.model.sessions).toHaveLength(1);
	});

	it("leaves a session's mode and model alone when they already match", async () => {
		const row = await make(
			{},
			{
				sessionMode: "existing",
				sessionId: "s1",
				modeId: "plan",
				modelId: undefined,
				permissionMode: "ask",
			}
		);
		await runNow(person.user._id, row._id.toString());
		expect(ops("session.setMode")).toHaveLength(0);
		expect(ops("session.setModel")).toHaveLength(0);
		expect(ops("session.setPermissionMode")).toHaveLength(0);
		expect(ops("session.prompt")).toHaveLength(1);
	});

	it("skips while that session is busy", async () => {
		machine.model.sessions[0].status = "busy";
		const row = await make({}, { sessionMode: "existing", sessionId: "s1" });
		const run = await runNow(person.user._id, row._id.toString());
		expect(run.status).toBe("skipped-still-running");
		expect(ops("session.prompt")).toHaveLength(0);
	});

	it("fails with a clear reason when the session is gone", async () => {
		const row = await make({}, { sessionMode: "existing", sessionId: "s1" });
		machine.model.sessions.length = 0;
		const run = await runNow(person.user._id, row._id.toString());
		expect(run.status).toBe("failed");
		expect(run.detail).toBe('The session "Long-running" no longer exists.');
	});
});

describe("when the machine is not there", () => {
	it("records missed-offline when it is offline, and queues nothing", async () => {
		const row = await make();
		machine.close();
		await vi.waitFor(() => expect(isMachineOnline(deviceId)).toBe(false));
		const run = await runNow(person.user._id, row._id.toString());
		expect(run.status).toBe("missed-offline");
		expect(run.detail).toMatch(/build box was offline/);
		const stored = await getSchedule(person.user._id, row._id.toString());
		expect(stored.enabled).toBe(true);
		expect(stored.consecutiveFailures).toBe(0);
	});

	it("disables the schedule, with a reason, when the machine was revoked", async () => {
		const row = await make();
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(deviceId) },
			{ $set: { status: "revoked" } }
		);
		const run = await runNow(person.user._id, row._id.toString());
		expect(run.status).toBe("failed");
		const stored = await getSchedule(person.user._id, row._id.toString());
		expect(stored.enabled).toBe(false);
		expect(stored.disabledReason).toMatch(/revoked or removed/);
		expect(ops("session.create")).toHaveLength(0);
	});

	it("switches its schedules off the moment the owner revokes the machine", async () => {
		const row = await make();
		const other = await make({ name: "Other" }, { sessionMode: "new" });
		const res = await testRequest(devicesDELETE, {
			method: "DELETE",
			path: `/api/v2/code/devices?id=${deviceId}`,
			locals: person.locals,
		});
		expect(res.status).toBe(200);
		for (const id of [row._id, other._id]) {
			const stored = (await collections.schedules.findOne({ _id: id })) as Schedule;
			expect(stored.enabled).toBe(false);
			expect(stored.nextRunAt).toBeNull();
			expect(stored.disabledReason).toMatch(/revoked/);
		}
	});
});

describe("when the workspace is gone", () => {
	it("fails with that reason, and switches the schedule off after three in a row", async () => {
		const row = await make();
		const id = row._id.toString();
		machine.model.workspaces.length = 0;
		for (let i = 0; i < 2; i++) {
			const run = await runNow(person.user._id, id);
			expect(run.status).toBe("failed");
			expect(run.detail).toBe('The workspace "repo" no longer exists on build box.');
			expect((await getSchedule(person.user._id, id)).enabled).toBe(true);
		}
		await runNow(person.user._id, id);
		const stored = await getSchedule(person.user._id, id);
		expect(stored.enabled).toBe(false);
		expect(stored.disabledReason).toMatch(/3 failed runs in a row.*no longer exists/);
		expect((await listRuns(person.user._id, id)).map((r) => r.status)).toEqual([
			"failed",
			"failed",
			"failed",
		]);
		expect(ops("session.create")).toHaveLength(0);
	});

	it("reports a refusal from the machine as a failure with its words", async () => {
		const row = await make();
		machine.onOp("session.create", () => {
			throw new OpError("forbidden", "workspace root not allowed");
		});
		const run = await runNow(person.user._id, row._id.toString());
		expect(run.status).toBe("failed");
		expect(run.detail).toMatch(/creating the session/);
	});
});

describe("the deployment switch for /code", () => {
	it("holds a run's kind unavailable while coding agents are off", () => {
		flags.codeAgents = false;
		expect(getExecutor("agent")?.available?.()).toBe(false);
		flags.codeAgents = true;
		expect(getExecutor("agent")?.available?.()).toBe(true);
	});
});

function sessionRow(id: string, workspaceId: string, title: string) {
	const now = new Date().toISOString();
	return {
		id,
		workspaceId,
		backend: "opencode",
		title,
		status: "idle" as const,
		pendingPermissions: 0,
		modeId: null,
		modelId: null,
		permissionMode: "ask" as const,
		parentId: null,
		createdAt: now,
		updatedAt: now,
		usage: null,
	};
}
