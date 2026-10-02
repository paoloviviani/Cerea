/**
 * The permission pass-through, panel half: opencode's rules decide and the
 * panel shows them. The forwarder offers a read (`permission-rules`), the
 * session's own rules (`session.setRules`, which the MACHINE caps by its
 * ceiling), a tightening delete of a saved "always" approval, and the
 * Auto-accept toggle (a per-session responder that never writes a rule).
 * Driven end to end against a fake machine over a real WebSocket.
 *
 * MOCK: the machine's `permission.rules` / `session.setRules` /
 * `permission.saved.remove` answers come from `tests/fake-machine.ts`, the
 * panel's reading of the frozen contract with the agent half
 * (feat/permission-agent) — not galopin's behaviour.
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
	it("passes the machine's rules and saved approvals through, asking about that session", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.model.permissionRules = SEED_RULES.map((rule) => ({ ...rule }));
		machine.model.savedApprovals = [{ id: "sa-1", permission: "bash", patterns: ["git status"] }];
		machine.model.permissionCeiling = { bash: "ask" };
		const asked: unknown[] = [];
		machine.onOp("permission.rules", (args: unknown) => {
			asked.push(args);
			return {
				agent: "build",
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
			rules: unknown[];
			savedApprovals: unknown[];
			ceiling: unknown;
		}>(res);
		expect(body.agent).toBe("build");
		expect(body.rules).toEqual([
			...SEED_RULES,
			{ permission: "bash", pattern: "*", action: "ask", source: "ceiling" },
		]);
		expect(body.ceiling).toEqual({ bash: "ask" });
		expect(body.savedApprovals).toEqual([
			{ id: "sa-1", permission: "bash", patterns: ["git status"] },
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

describe("DELETE v1/agents/:id/permission-approvals/:approvalId", () => {
	it("forgets the approval by id, sends nothing else, and audits who did it", async () => {
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
		// An approval's patterns are the command text for bash: never audited.
		expect(JSON.stringify(rows)).not.toContain("rm -rf");
		machine.close();
	});

	it("passes the machine's refusal of an approval it will not withdraw (removable: false)", async () => {
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

describe("the session-rules writer is ceiling-limited", () => {
	const rulesUrl = (sessionId: string, deviceId: string) =>
		`/api/v2/code/v1/agents/${sessionId}/permission-rules?device=${deviceId}`;

	async function read(sessionId: string, deviceId: string) {
		return parse<{
			rules: Array<{ permission: string; pattern: string; action: string; source?: string }>;
			ceiling: Record<string, string>;
		}>(await forwarder(forwarderGET, rulesUrl(sessionId, deviceId), { locals: user.locals }));
	}

	async function write(sessionId: string, deviceId: string, body: unknown) {
		return forwarder(forwarderPOST, rulesUrl(sessionId, deviceId), {
			method: "POST",
			body: JSON.stringify(body),
			locals: user.locals,
		});
	}

	it("sends the session's rules to the machine, and a re-read shows them in force", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.model.permissionCeiling = { bash: "ask" };
		machine.opLog.length = 0;

		const res = await write(sessionId, deviceId, {
			rules: [
				{ permission: "edit", pattern: "*", action: "allow" },
				{ permission: "bash", pattern: "git *", action: "ask" },
			],
		});
		expect(res.status).toBe(200);
		expect(machine.opLog).toEqual([
			{
				op: "session.setRules",
				args: {
					sessionId,
					rules: [
						{ permission: "edit", pattern: "*", action: "allow" },
						{ permission: "bash", pattern: "git *", action: "ask" },
					],
				},
			},
		]);
		const inForce = (await read(sessionId, deviceId)).rules.filter((r) => r.source === "cerea");
		expect(inForce.map((r) => [r.permission, r.pattern, r.action])).toEqual([
			["edit", "*", "allow"],
			["bash", "git *", "ask"],
		]);
		machine.close();
	});

	it("an over-ceiling rule is clamped by the machine, and the re-read shows the clamp, not the ask", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.model.permissionCeiling = { bash: "ask", webfetch: "deny" };

		const res = await write(sessionId, deviceId, {
			rules: [
				{ permission: "bash", pattern: "*", action: "allow" },
				{ permission: "webfetch", pattern: "*", action: "ask" },
				{ permission: "edit", pattern: "*", action: "allow" },
			],
		});
		// The call lands; the answer is not a statement of what is in force.
		expect(res.status).toBe(200);
		const after = await read(sessionId, deviceId);
		const cerea = after.rules.filter((r) => r.source === "cerea");
		expect(cerea.map((r) => [r.permission, r.action])).toEqual([
			["bash", "ask"],
			["webfetch", "deny"],
			["edit", "allow"],
		]);
		expect(after.ceiling).toEqual({ bash: "ask", webfetch: "deny" });
		machine.close();
	});

	it("an over-ceiling rule the machine refuses is a 403 with its words, audited, and nothing changes", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.model.permissionCeiling = { bash: "ask" };
		machine.model.overCeiling = "refuse";

		const res = await write(sessionId, deviceId, {
			rules: [{ permission: "bash", pattern: "rm *", action: "allow" }],
		});
		expect(res.status).toBe(403);
		expect((await read(sessionId, deviceId)).rules.filter((r) => r.source === "cerea")).toEqual([]);
		const rows = await collections.codeAudit
			.find({ deviceId: new ObjectId(deviceId), action: "permission.rules.set" })
			.toArray();
		expect(rows.map((row) => [row.sessionId, row.count, row.outcome])).toEqual([
			[sessionId, 1, "refused"],
		]);
		// A rule's pattern can be command text: never audited.
		expect(JSON.stringify(rows)).not.toContain("rm *");
		machine.close();
	});

	it("audits a landed write by session and count", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		await write(sessionId, deviceId, {
			rules: [{ permission: "edit", pattern: "*", action: "ask" }],
		});
		const rows = await collections.codeAudit
			.find({ deviceId: new ObjectId(deviceId), action: "permission.rules.set" })
			.toArray();
		expect(rows.map((row) => [row.sessionId, row.count, row.outcome])).toEqual([
			[sessionId, 1, "sent"],
		]);
		machine.close();
	});

	it("never forwards anything but the three fields: opencode's `tools` map is dropped", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.opLog.length = 0;
		const res = await write(sessionId, deviceId, {
			tools: { bash: true },
			ceiling: { bash: "allow" },
			rules: [{ permission: "edit", pattern: "*", action: "ask", tools: {}, source: "ceiling" }],
		});
		expect(res.status).toBe(200);
		expect(machine.opLog).toEqual([
			{
				op: "session.setRules",
				args: { sessionId, rules: [{ permission: "edit", pattern: "*", action: "ask" }] },
			},
		]);
		machine.close();
	});

	it("refuses a malformed body before the machine sees it", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.opLog.length = 0;
		const bad: unknown[] = [
			{},
			{ rules: "all" },
			{ rules: [{ permission: "edit", pattern: "*", action: "sometimes" }] },
			{ rules: [{ permission: "", pattern: "*", action: "ask" }] },
			{ rules: [{ permission: "edit", pattern: "", action: "ask" }] },
			{ rules: [{ permission: "bad name!", pattern: "*", action: "ask" }] },
			{
				rules: Array.from({ length: 65 }, () => ({
					permission: "edit",
					pattern: "*",
					action: "ask",
				})),
			},
		];
		for (const body of bad) {
			expect(
				(await write(sessionId, deviceId, body)).status,
				JSON.stringify(body).slice(0, 60)
			).toBe(400);
		}
		expect(machine.opLog).toEqual([]);
		machine.close();
	});

	it("can clear them: an empty list is a valid write", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		await write(sessionId, deviceId, {
			rules: [{ permission: "edit", pattern: "*", action: "ask" }],
		});
		expect((await write(sessionId, deviceId, { rules: [] })).status).toBe(200);
		expect((await read(sessionId, deviceId)).rules.filter((r) => r.source === "cerea")).toEqual([]);
		machine.close();
	});

	it("offers no route for the ceiling, the machine's rules or policy, and DELETE only reaches an approval", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		for (const path of [
			"v1/agents/s1/permission-approvals",
			"v1/agents/s1/permission-approvals/sa-1",
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

	it("refuses a device that belongs to a different user", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const otherUser = await createTestUser();
		const res = await forwarder(forwarderPOST, rulesUrl("s1", deviceId), {
			method: "POST",
			body: JSON.stringify({ rules: [] }),
			locals: otherUser.locals,
		});
		expect(res.status).toBe(404);
		machine.close();
	});

	it("flipping Auto-accept sends session.setAutoAccept and nothing that touches rules", async () => {
		const machine = await connectAndPair({
			policy: {
				permission: { responders: "allowed" },
				workspaceRoots: [],
				allowFreeModels: false,
			},
		});
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.opLog.length = 0;

		const on = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${sessionId}/feature?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ featureId: "auto_accept", value: true }),
				locals: user.locals,
			}
		);
		expect(on.status).toBe(200);
		expect(machine.opLog).toEqual([
			{ op: "session.setAutoAccept", args: { sessionId, enabled: true } },
		]);
		// And a feature it does not know is not a back door to another op.
		const other = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${sessionId}/feature?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ featureId: "permission_rules", value: true }),
				locals: user.locals,
			}
		);
		expect(other.status).toBe(404);
		expect(machine.opLog).toHaveLength(1);
		machine.close();
	});

	it("will not switch a responder on for a machine that did not say yes, and still lets one be turned off", async () => {
		const machine = await connectAndPair({
			policy: { workspaceRoots: [], allowFreeModels: false },
		});
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.opLog.length = 0;
		const url = `/api/v2/code/v1/agents/${sessionId}/feature?device=${deviceId}`;
		const on = await forwarder(forwarderPOST, url, {
			method: "POST",
			body: JSON.stringify({ featureId: "auto_accept", value: true }),
			locals: user.locals,
		});
		expect(on.status).toBe(403);
		expect(machine.opLog).toEqual([]);
		const off = await forwarder(forwarderPOST, url, {
			method: "POST",
			body: JSON.stringify({ featureId: "auto_accept", value: false }),
			locals: user.locals,
		});
		expect(off.status).toBe(200);
		machine.close();
	});
});

describe("the Auto-accept toggle says what it is", () => {
	async function feature(policy: Record<string, unknown>) {
		const machine = await connectAndPair({
			policy: { workspaceRoots: [], allowFreeModels: false, ...policy } as never,
		});
		const deviceId = machine.deviceId as string;
		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/providers/opencode/features?device=${deviceId}&cwd=/repo`,
			{ locals: user.locals }
		);
		const body = await parse<{
			features: Array<{ id: string; description?: string; blockedReason?: string }>;
		}>(res);
		machine.close();
		return body.features[0];
	}

	it("describes the responder honestly: once, tool asks only, capped, no questions, no denies, no saved approvals", async () => {
		const toggle = await feature({ permission: { responders: "allowed" } });
		expect(toggle.id).toBe("auto_accept");
		expect(toggle.blockedReason).toBeUndefined();
		expect(toggle.description).toMatch(/allow once/);
		expect(toggle.description).toMatch(/only what this machine's ceiling allows/);
		expect(toggle.description).toMatch(/Never answers questions/);
		expect(toggle.description).toMatch(/never overrides a deny/);
		expect(toggle.description).toMatch(/never saves an approval/);
		expect(toggle.description).not.toMatch(/rule[s]? (is|are) written|writes/i);
	});

	it("still reads the older autoAccept word when the machine reports nothing newer", async () => {
		expect((await feature({ autoAccept: "allowed" })).blockedReason).toBeUndefined();
	});

	it("is blocked, with the fix, when the machine's responders are denied", async () => {
		const toggle = await feature({ permission: { responders: "denied" } });
		expect(toggle.blockedReason).toMatch(/--allow-auto-accept/);
		expect(toggle.blockedReason).toMatch(/ceiling/);
	});

	it("is blocked, not offered live, when the machine reports no responder field at all", async () => {
		const toggle = await feature({});
		expect(toggle.blockedReason).toMatch(/--allow-auto-accept/);
	});

	it("lets the newer word beat the older one", async () => {
		const toggle = await feature({ autoAccept: "allowed", permission: { responders: "denied" } });
		expect(toggle.blockedReason).toBeDefined();
	});
});
