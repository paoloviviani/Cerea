/**
 * The permission selector, panel half: opencode's rules decide and the panel
 * shows them. The forwarder offers a read (`permission-rules`), the session's
 * blanket (`permission-mode` → `session.setPermissionMode`: Deny / Ask /
 * Allow, which the MACHINE caps by its ceiling) and a tightening delete of
 * one exception (what "Always allow" left behind). Driven end to end against
 * a fake machine over a real WebSocket.
 *
 * MOCK: the machine's `permission.rules` / `session.setPermissionMode` /
 * `permission.saved.remove` answers come from `tests/fake-machine.ts`, the
 * panel's reading of the frozen contract with the agent half
 * (feat/permission-selector-agent) — not galopin's behaviour. OC reconciles
 * the two end to end.
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
import { OpError } from "$lib/types/machineProtocol";
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

function ceilingTail(machine: FakeMachine) {
	return Object.entries(machine.model.permissionCeiling).map(([permission, action]) => ({
		permission,
		pattern: "*",
		action,
		source: "ceiling",
	}));
}

const SEED_RULES = [
	{ permission: "edit", pattern: "*", action: "ask", source: "machine" },
	{ permission: "webfetch", pattern: "*", action: "allow", source: "opencode" },
] as const;

describe("GET v1/agents/:id/permission-rules", () => {
	it("passes the machine's rules, mode and exceptions through, asking about that session", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.model.permissionRules = SEED_RULES.map((rule) => ({ ...rule }));
		machine.model.savedApprovals = [
			{
				id: "ex_1",
				permission: "bash",
				patterns: ["git status"],
				removable: true,
				grantedAt: "2026-10-03T09:00:00Z",
			},
		];
		machine.model.permissionCeiling = { bash: "ask" };
		const asked: unknown[] = [];
		machine.onOp("permission.rules", (args: unknown) => {
			asked.push(args);
			return {
				agent: "build",
				mode: "ask",
				rules: [...machine.model.permissionRules, ...ceilingTail(machine)],
				savedApprovals: machine.model.savedApprovals,
				ceiling: machine.model.permissionCeiling,
			};
		});

		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/agents/${sessionId}/permission-rules?device=${deviceId}`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(200);
		expect(asked).toEqual([{ sessionId }]);
		const body = await parse<{
			agent?: string;
			mode?: string;
			rules: unknown[];
			savedApprovals: unknown[];
			ceiling: unknown;
		}>(res);
		expect(body.agent).toBe("build");
		expect(body.mode).toBe("ask");
		expect(body.rules).toEqual([
			...SEED_RULES,
			{ permission: "bash", pattern: "*", action: "ask", source: "ceiling" },
		]);
		expect(body.ceiling).toEqual({ bash: "ask" });
		expect(body.savedApprovals).toEqual([
			{
				id: "ex_1",
				permission: "bash",
				patterns: ["git status"],
				removable: true,
				grantedAt: "2026-10-03T09:00:00Z",
			},
		]);
		machine.close();
	});

	it("keeps the entries it can read and drops the ones it cannot", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.onOp("permission.rules", () => ({
			rules: [
				{ permission: "edit", pattern: "*", action: "ask" },
				{ permission: "bash", pattern: "*", action: "sometimes" },
				"nonsense",
			],
			savedApprovals: [{ id: "sa-1", permission: "edit" }, { permission: "no id" }],
			mode: "sometimes",
			ceiling: { bash: "ask", edit: "allow", webfetch: 3 },
			extra: "ignored",
		}));
		const body = await parse<{ rules: unknown[]; savedApprovals: unknown[] }>(
			await forwarder(
				forwarderGET,
				`/api/v2/code/v1/agents/${sessionId}/permission-rules?device=${deviceId}`,
				{ locals: user.locals }
			)
		);
		expect(body).toEqual({
			rules: [{ permission: "edit", pattern: "*", action: "ask" }],
			savedApprovals: [{ id: "sa-1", permission: "edit", patterns: [] }],
			// A mode that is none of the three words is dropped, never guessed at;
			// "allow" is not a cap and 3 is not an action: only a real cap survives.
			ceiling: { bash: "ask" },
		});
		machine.close();
	});

	it("is a 404 on a galopin that predates the op, so the line can hide itself", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.onOp("permission.rules", () => {
			throw new OpError("unsupported", "unknown op");
		});
		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/agents/${sessionId}/permission-rules?device=${deviceId}`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(404);
		machine.close();
	});

	it("refuses a device that belongs to a different user", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const otherUser = await createTestUser();
		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/agents/s1/permission-rules?device=${deviceId}`,
			{ locals: otherUser.locals }
		);
		expect(res.status).toBe(404);
		machine.close();
	});
});

describe("DELETE v1/agents/:id/permission-approvals/:exceptionId", () => {
	it("removes the exception by id, sends nothing else, and audits who did it", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.model.savedApprovals = [
			{ id: "sa-1", permission: "bash", patterns: ["rm -rf build"] },
			{ id: "sa-2", permission: "edit", patterns: ["src/**"] },
		];
		const res = await forwarder(
			forwarderDELETE,
			`/api/v2/code/v1/agents/${sessionId}/permission-approvals/sa-1?device=${deviceId}`,
			{ method: "DELETE", locals: user.locals }
		);
		expect(res.status).toBe(200);
		expect(machine.opLog.filter((entry) => entry.op === "permission.saved.remove")).toEqual([
			{ op: "permission.saved.remove", args: { id: "sa-1", sessionId } },
		]);
		expect(machine.model.savedApprovals.map((approval) => approval.id)).toEqual(["sa-2"]);

		const rows = await collections.codeAudit
			.find({ deviceId: new ObjectId(deviceId), action: "permission.saved.remove" })
			.toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ sessionId, approvalId: "sa-1", outcome: "removed" });
		// An exception's patterns are the command text for bash: never audited.
		expect(JSON.stringify(rows)).not.toContain("rm -rf");
		machine.close();
	});

	it("passes the machine's refusal of an exception it will not withdraw (removable: false)", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.model.savedApprovals = [
			{ id: "sa-9", permission: "bash", patterns: ["ls"], removable: false },
		];
		const res = await forwarder(
			forwarderDELETE,
			`/api/v2/code/v1/agents/${sessionId}/permission-approvals/sa-9?device=${deviceId}`,
			{ method: "DELETE", locals: user.locals }
		);
		expect(res.status).toBe(403);
		expect(machine.model.savedApprovals).toHaveLength(1);
		machine.close();
	});

	it("audits a refusal and answers with the machine's error", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		const res = await forwarder(
			forwarderDELETE,
			`/api/v2/code/v1/agents/${sessionId}/permission-approvals/gone?device=${deviceId}`,
			{ method: "DELETE", locals: user.locals }
		);
		expect(res.status).toBe(404);
		const rows = await collections.codeAudit
			.find({ deviceId: new ObjectId(deviceId), action: "permission.saved.remove" })
			.toArray();
		expect(rows.map((row) => [row.approvalId, row.outcome])).toEqual([["gone", "refused"]]);
		machine.close();
	});

	it("answers instantly once the machine is offline", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		machine.close();
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		const start = Date.now();
		const res = await forwarder(
			forwarderDELETE,
			`/api/v2/code/v1/agents/s1/permission-approvals/sa-1?device=${deviceId}`,
			{ method: "DELETE", locals: user.locals }
		);
		expect(res.status).toBe(502);
		expect(Date.now() - start).toBeLessThan(2000);
	});
});

describe("POST v1/agents/:id/permission-mode", () => {
	const modeUrl = (sessionId: string, deviceId: string) =>
		`/api/v2/code/v1/agents/${sessionId}/permission-mode?device=${deviceId}`;

	async function post(sessionId: string, deviceId: string, body: unknown, locals = user.locals) {
		return forwarder(forwarderPOST, modeUrl(sessionId, deviceId), {
			method: "POST",
			body: JSON.stringify(body),
			locals,
		});
	}

	async function read(sessionId: string, deviceId: string) {
		return parse<{ mode?: string; rules: Array<{ source?: string; action: string }> }>(
			await forwarder(
				forwarderGET,
				`/api/v2/code/v1/agents/${sessionId}/permission-rules?device=${deviceId}`,
				{ locals: user.locals }
			)
		);
	}

	it("maps each of the three words onto session.setPermissionMode, and a re-read shows the machine's word", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		// New sessions start on Ask.
		expect((await read(sessionId, deviceId)).mode).toBe("ask");
		for (const mode of ["allow", "deny", "ask"] as const) {
			machine.opLog.length = 0;
			expect((await post(sessionId, deviceId, { mode })).status, mode).toBe(200);
			expect(machine.opLog).toEqual([
				{ op: "session.setPermissionMode", args: { sessionId, mode } },
			]);
			expect((await read(sessionId, deviceId)).mode).toBe(mode);
		}
		machine.close();
	});

	it("the snapshot carries the machine's permissionMode (a child reports its root's)", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		const root = machine.model.sessions[0];
		machine.model.sessions.push({ ...root, id: "child-1", parentId: sessionId });
		await post(sessionId, deviceId, { mode: "allow" });
		for (const id of [sessionId, "child-1"]) {
			const body = await parse<{ agent: { permissionMode?: string } }>(
				await forwarder(forwarderGET, `/api/v2/code/v1/agents/${id}?device=${deviceId}`, {
					locals: user.locals,
				})
			);
			expect(body.agent.permissionMode, id).toBe("allow");
		}
		machine.close();
	});

	it("audits a landed change by session and mode, and a refusal as refused", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		await post(sessionId, deviceId, { mode: "deny" });
		const root = machine.model.sessions[0];
		machine.model.sessions.push({ ...root, id: "child-1", parentId: sessionId });
		expect((await post("child-1", deviceId, { mode: "allow" })).status).toBe(400);
		const rows = await collections.codeAudit
			.find({ deviceId: new ObjectId(deviceId), action: "permission.mode" })
			.toArray();
		expect(rows.map((row) => [row.sessionId, row.mode, row.outcome])).toEqual([
			[sessionId, "deny", "sent"],
			["child-1", "allow", "refused"],
		]);
		machine.close();
	});

	it("a subagent's id is the machine's `invalid`, a 400 with its words: it follows its root", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		const root = machine.model.sessions[0];
		machine.model.sessions.push({ ...root, id: "child-1", parentId: sessionId });
		const res = await post("child-1", deviceId, { mode: "allow" });
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("a subagent follows its root");
		machine.close();
	});

	it("an unknown session is the machine's not_found, a 404", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		expect((await post("nope", deviceId, { mode: "ask" })).status).toBe(404);
		machine.close();
	});

	it("refuses a malformed body before the machine sees it", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.opLog.length = 0;
		for (const body of [{}, { mode: "sometimes" }, { mode: "ALLOW" }, { mode: true }, "allow"]) {
			expect((await post(sessionId, deviceId, body)).status, JSON.stringify(body)).toBe(400);
		}
		expect(machine.opLog).toEqual([]);
		machine.close();
	});

	it("forwards nothing but the mode: extra keys are dropped", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.opLog.length = 0;
		const res = await post(sessionId, deviceId, {
			mode: "allow",
			ceiling: { bash: "allow" },
			rules: [{ permission: "bash", pattern: "*", action: "allow" }],
		});
		expect(res.status).toBe(200);
		expect(machine.opLog).toEqual([
			{ op: "session.setPermissionMode", args: { sessionId, mode: "allow" } },
		]);
		machine.close();
	});

	it("answers instantly once the machine is offline", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		machine.close();
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		const start = Date.now();
		expect((await post("s1", deviceId, { mode: "ask" })).status).toBe(502);
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("refuses a device that belongs to a different user", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const otherUser = await createTestUser();
		expect((await post("s1", deviceId, { mode: "allow" }, otherUser.locals)).status).toBe(404);
		machine.close();
	});
});

describe("what the panel can reach, and no more", () => {
	it("has no route for the ceiling, the machine's rules or policy; the retired writers are gone", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		for (const path of [
			// Retired: the free-form rules writer, the feature toggle and its lists.
			"v1/agents/s1/permission-rules",
			"v1/agents/s1/feature",
			// Never offered.
			"v1/agents/s1/permission-approvals",
			"v1/agents/s1/permission-approvals/ex-1",
			"v1/agents/s1/permission-ceiling",
			"v1/agents/s1/policy",
			"v1/agents/s1/permissions",
			"v1/permissions",
			"v1/policy",
		]) {
			const res = await forwarder(forwarderPOST, `/api/v2/code/${path}?device=${deviceId}`, {
				method: "POST",
				body: JSON.stringify({ rules: [{ permission: "edit", pattern: "*", action: "allow" }] }),
				locals: user.locals,
			});
			expect(res.status, path).toBe(404);
		}
		const features = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/providers/opencode/features?device=${deviceId}&cwd=/repo`,
			{ locals: user.locals }
		);
		expect(features.status).toBe(404);
		for (const path of ["v1/agents/s1/permission-rules", "v1/agents/s1/permission-ceiling"]) {
			const res = await forwarder(forwarderDELETE, `/api/v2/code/${path}?device=${deviceId}`, {
				method: "DELETE",
				locals: user.locals,
			});
			expect(res.status, path).toBe(404);
		}
		expect(machine.opLog.map((entry) => entry.op)).toEqual([]);
		machine.close();
	});

	it("nothing in the forwarder sends session.setAutoAccept or session.setRules any more", async () => {
		const source = await import("node:fs").then((fs) =>
			fs.readFileSync(new URL("../[...path]/+server.ts", import.meta.url), "utf8")
		);
		expect(source).not.toMatch(/setAutoAccept|setRules|auto_accept|responders/i);
	});
});
