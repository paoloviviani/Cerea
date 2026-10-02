/**
 * The permission pass-through, panel half: opencode's rules decide and the
 * panel SHOWS them. The forwarder offers one read (`permission-rules`), one
 * tightening write (forget a saved "always" approval, audited), and the
 * Auto-accept toggle, which is a per-session responder that never writes a
 * rule. Driven end to end against a fake machine over a real WebSocket.
 *
 * MOCK: the machine's `permission.rules` / `permission.saved.remove` answers
 * come from `tests/fake-machine.ts`, the panel's reading of the contract
 * with the agent half (feat/permission-agent) — not galopin's behaviour.
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

const SEED_RULES = [
	{ permission: "edit", pattern: "*", action: "ask", source: "cerea" },
	{ permission: "bash", pattern: "*", action: "ask", source: "ceiling" },
	{ permission: "webfetch", pattern: "*", action: "allow", source: "file" },
] as const;

describe("GET v1/agents/:id/permission-rules", () => {
	it("passes the machine's rules and saved approvals through, asking about that session", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(deviceId);
		machine.model.permissionRules = SEED_RULES.map((rule) => ({ ...rule }));
		machine.model.savedApprovals = [{ id: "sa-1", permission: "bash", patterns: ["git status"] }];
		const asked: unknown[] = [];
		machine.onOp("permission.rules", (args: unknown) => {
			asked.push(args);
			return {
				rules: machine.model.permissionRules,
				savedApprovals: machine.model.savedApprovals,
			};
		});

		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/agents/${sessionId}/permission-rules?device=${deviceId}`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(200);
		expect(asked).toEqual([{ sessionId }]);
		const body = await parse<{ rules: unknown[]; savedApprovals: unknown[] }>(res);
		expect(body.rules).toEqual(SEED_RULES);
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
			{ op: "permission.saved.remove", args: { id: "sa-1" } },
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

describe("the panel never writes a permission rule", () => {
	it("offers no way to add, edit or replace one: POST to either path is not available", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		for (const path of [
			"v1/agents/s1/permission-rules",
			"v1/agents/s1/permission-approvals",
			"v1/agents/s1/permission-approvals/sa-1",
			"v1/agents/s1/permissions",
			"v1/permissions",
		]) {
			const res = await forwarder(forwarderPOST, `/api/v2/code/${path}?device=${deviceId}`, {
				method: "POST",
				body: JSON.stringify({ rules: [{ permission: "edit", pattern: "*", action: "allow" }] }),
				locals: user.locals,
			});
			expect(res.status, path).toBe(404);
		}
		expect(machine.opLog.map((entry) => entry.op)).toEqual([]);
		machine.close();
	});

	it("flipping Auto-accept sends session.setAutoAccept and nothing that touches rules", async () => {
		const machine = await connectAndPair({
			policy: { autoAccept: "allowed", workspaceRoots: [], allowFreeModels: false },
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

	it("describes the responder honestly: once, tool asks only, no questions, no denies, no saved approvals", async () => {
		const toggle = await feature({ autoAccept: "allowed" });
		expect(toggle.id).toBe("auto_accept");
		expect(toggle.blockedReason).toBeUndefined();
		expect(toggle.description).toMatch(/allow once/);
		expect(toggle.description).toMatch(/Never answers questions/);
		expect(toggle.description).toMatch(/never overrides a deny/);
		expect(toggle.description).toMatch(/never saves an approval/);
		expect(toggle.description).not.toMatch(/rule[s]? (is|are) written|writes/i);
	});

	it("is blocked, with the fix, when the machine's ceiling does not allow responders", async () => {
		const toggle = await feature({ autoAccept: "denied" });
		expect(toggle.blockedReason).toMatch(/--allow-auto-accept/);
		expect(toggle.blockedReason).toMatch(/ceiling/);
	});

	it("is offered, for the machine to refuse, when the machine reports no responder flag", async () => {
		const toggle = await feature({});
		expect(toggle.blockedReason).toBeUndefined();
	});
});
