/**
 * The chat's `agent_*` tools (ADR 0106) against the fake machine the /code specs share
 * (`tests/fake-machine.ts`) over a real WebSocket and the real `MachineLink`: what a call does is
 * read off the ops the machine received (`opLog`), which is the contract with galopin.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { OpError, type Part, type Session } from "$lib/types/machineProtocol";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import { acceptMachineConnection, isMachineOnline } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { PATCH as devicesPATCH } from "../../../../routes/api/v2/code/devices/+server";
import { FakeMachine } from "../../../../../tests/fake-machine";
import { resumeParkedToolCall } from "$lib/server/mcp/resumeElicitation";
import { saveProjectAgentProfile } from "$lib/server/projectAgentProfiles";
import { getEnabledBuiltinTools } from "./index";
import {
	AGENT_READ_TOOL_NAME,
	AGENT_SEND_TOOL_NAME,
	AGENT_SESSIONS_TOOL_NAME,
	AGENT_START_TOOL_NAME,
	MAX_LAST_ANSWER_CHARS,
	MAX_TRANSCRIPT_CHARS,
	agentSessionsFor,
	createAgentSessionBuiltins,
	runAgentSessionTool,
} from "./agentSessionTools";
import { EXTERNAL_BUILTIN_TOOLS, UNTRUSTED_DESCRIPTION_SUFFIX } from "../untrusted";

const flags = vi.hoisted(() => ({ codeAgents: true }));
vi.mock("$lib/server/codeEnabled", async (original) => ({
	...(await original<typeof import("$lib/server/codeEnabled")>()),
	codeAgentsEnabled: () => flags.codeAgents,
	codeAgentsAllowedFor: async () => true,
}));

let httpServer: Server;
let wss: WebSocketServer;
let port: number;
let principal: MachinePrincipal;
let person: Awaited<ReturnType<typeof createTestUser>>;
let machine: FakeMachine;
let deviceId: string;
let conversationId: ObjectId;
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

/** Pair a fake machine to `owner` (the principal the connection authenticates as). */
async function pairFor(owner: Awaited<ReturnType<typeof createTestUser>>): Promise<FakeMachine> {
	principal = {
		userId: owner.user._id,
		sub: owner.user.hfUserId,
		iss: "http://fake-issuer.invalid",
		exp: Math.floor(Date.now() / 1000) + 3600,
		machineId: randomUUID(),
		machineName: "build box",
	};
	const m = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {}, {});
	machines.push(m);
	const { deviceId: id } = await m.hello();
	const res = await testRequest(devicesPATCH, {
		method: "PATCH",
		path: `/api/v2/code/devices?id=${id}`,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: "confirm" }),
		locals: owner.locals,
	});
	expect(res.status).toBe(200);
	await m.waitForPaired();
	m.model.workspaces.push({
		id: "ws1",
		name: "repo",
		path: "/work/repo",
		createdAt: new Date().toISOString(),
		isGitRepo: true,
	});
	// galopin answers not_found for an unknown session (PROTOCOL.md §6).
	m.onOp<{ sessionId: string }>("session.get", ({ sessionId }) => {
		const session = m.model.sessions.find((s) => s.id === sessionId);
		if (!session) throw new OpError("not_found", `no such session ${sessionId}`);
		return { session: { ...session } };
	});
	return m;
}

const ops = (name: string, m: FakeMachine = machine) => m.opLog.filter((o) => o.op === name);

function addSession(m: FakeMachine, over: Partial<Session> = {}): Session {
	const now = new Date().toISOString();
	const session: Session = {
		id: randomUUID(),
		workspaceId: "ws1",
		backend: "opencode",
		title: "Existing work",
		status: "idle",
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
	m.model.sessions.push(session);
	m.model.transcripts.set(session.id, {
		messages: [],
		permissions: [],
		status: "idle",
		usage: null,
		todos: [],
	});
	return session;
}

const textPart = (messageId: string, role: string, text: string): Part => ({
	id: randomUUID(),
	messageId,
	role,
	type: "text",
	text,
});

function say(m: FakeMachine, sessionId: string, role: "user" | "assistant", text: string) {
	const id = randomUUID();
	m.model.transcripts.get(sessionId)?.messages.push({
		message: { id, role, createdAt: new Date().toISOString() },
		parts: [textPart(id, role, text)],
	});
}

const ctx = () => ({
	userId: person.user._id,
	conversationId,
	sessionId: person.session.sessionId,
});
const run = (name: string, args: Record<string, unknown>) => runAgentSessionTool(name, args, ctx());
const parse = (outcome: Awaited<ReturnType<typeof run>>) => {
	if ("error" in outcome) throw new Error(`unexpected refusal: ${outcome.error}`);
	return JSON.parse(outcome.text) as Record<string, unknown>;
};
const errorOf = (outcome: Awaited<ReturnType<typeof run>>) => {
	if (!("error" in outcome)) throw new Error("expected a refusal");
	return outcome.error;
};
const auditRows = () => collections.codeAudit.find({}).sort({ at: 1 }).toArray();

async function waitOffline(id: string) {
	for (let i = 0; i < 100 && isMachineOnline(id); i++) await new Promise((r) => setTimeout(r, 20));
	expect(isMachineOnline(id)).toBe(false);
}

beforeEach(async () => {
	flags.codeAgents = true;
	person = await createTestUser();
	await collections.sessions.updateOne(
		{ sessionId: person.session.sessionId },
		{ $set: { authTime: new Date() } }
	);
	machine = await pairFor(person);
	deviceId = machine.deviceId as string;
	conversationId = new ObjectId();
	await collections.conversations.insertOne({
		_id: conversationId,
		userId: person.user._id,
		title: "Chat",
		model: "m",
		rootMessageId: "r",
		messages: [{ id: "r", from: "system", content: "", ancestors: [], children: [] }],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
});

afterEach(async () => {
	for (const m of machines.splice(0)) m.close();
	await collections.projectAgentProfiles.deleteMany({});
	await collections.projects.deleteMany({});
	await collections.codeAudit.deleteMany({});
	await cleanupTestData();
});

describe("agent_sessions", () => {
	it("lists the caller's own machines with workspaces and sessions, and the project default", async () => {
		addSession(machine, { title: "Refactor", status: "busy" });
		addSession(machine, { title: "Review", pendingPermissions: 1 });
		const projectId = await projectWithConversation();
		const saved = await saveProjectAgentProfile(projectId, person.user._id, {
			deviceId,
			workspaceId: "ws1",
			permissionMode: "allow",
		});
		expect(saved.ok).toBe(true);

		const out = parse(await run(AGENT_SESSIONS_TOOL_NAME, {}));
		const [m] = out.machines as Array<{ sessions: Array<{ title: string; state: string }> }>;
		expect(m).toMatchObject({
			id: deviceId,
			state: "online",
			workspaces: [{ id: "ws1", name: "repo" }],
		});
		expect(m.sessions.map((s) => [s.title, s.state]).sort()).toEqual([
			["Refactor", "working"],
			["Review", "needs-you"],
		]);
		expect(out.projectDefault).toMatchObject({
			deviceId,
			workspaceId: "ws1",
			workspace: "repo",
			permissionMode: "allow",
		});
	});

	it("never shows another user's machine", async () => {
		const other = await createTestUser();
		const theirs = await pairFor(other);
		const out = parse(await run(AGENT_SESSIONS_TOOL_NAME, {}));
		expect((out.machines as Array<{ id: string }>).map((x) => x.id)).toEqual([deviceId]);
		expect(
			theirs.opLog.filter((o) => o.op.startsWith("session.") || o.op === "workspace.list")
		).toEqual([]);
	});

	it("says a machine that is away is offline", async () => {
		await machine.close();
		await waitOffline(deviceId);
		const out = parse(await run(AGENT_SESSIONS_TOOL_NAME, {}));
		expect((out.machines as Array<{ state: string }>)[0].state).toBe("offline");
	});
});

describe("agent_start", () => {
	it("without a project profile starts on Ask, sends the prompt and returns at once with the ids", async () => {
		const outcome = await run(AGENT_START_TOOL_NAME, {
			deviceId,
			workspaceId: "ws1",
			prompt: "Fix the flaky test",
		});
		const out = parse(outcome);
		expect(out).toMatchObject({
			started: true,
			deviceId,
			workspaceId: "ws1",
			permissionMode: "Ask",
		});
		const session = machine.model.sessions.find((s) => s.id === out.sessionId);
		expect(session).toMatchObject({ permissionMode: "ask", title: "Fix the flaky test" });
		expect(ops("session.setPermissionMode")).toHaveLength(0);
		expect(ops("session.prompt")).toHaveLength(1);
		expect(ops("session.prompt")[0].args).toMatchObject({
			sessionId: out.sessionId,
			text: "Fix the flaky test",
		});
		// The card is emitted with the call and survives a reload with the message.
		expect("extraUpdates" in outcome && outcome.extraUpdates).toEqual([
			{
				type: MessageUpdateType.AgentSession,
				action: "started",
				deviceId,
				workspaceId: "ws1",
				sessionId: out.sessionId,
				title: "Fix the flaky test",
				labels: { device: "build box", workspace: "repo" },
			},
		]);
	});

	it("with a project profile uses its machine, workspace, mode, model and permission word", async () => {
		const projectId = await projectWithConversation();
		await saveProjectAgentProfile(projectId, person.user._id, {
			deviceId,
			workspaceId: "ws1",
			permissionMode: "allow",
			modeId: "build",
			modelId: "pystino/mock-model",
		});
		const out = parse(await run(AGENT_START_TOOL_NAME, { prompt: "Ship it" }));
		const session = machine.model.sessions.find((s) => s.id === out.sessionId);
		expect(session).toMatchObject({
			permissionMode: "allow",
			modeId: "build",
			modelId: "pystino/mock-model",
		});
		expect(ops("session.setPermissionMode")[0].args).toMatchObject({ mode: "allow" });
	});

	it("switches on the project's connector default for the session it starts, before the prompt", async () => {
		const { seal } = await import("$lib/server/mcp/secretBox");
		const connector = {
			_id: new ObjectId(),
			userId: person.user._id,
			scope: "user" as const,
			name: "Tracker",
			url: "https://tracker.test/mcp",
			auth: "token" as const,
			tokenSealed: seal("t"),
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		await collections.mcpConnectors.insertOne(connector);
		try {
			const projectId = await projectWithConversation();
			const key = `connector:${connector._id}`;
			await saveProjectAgentProfile(projectId, person.user._id, {
				deviceId,
				workspaceId: "ws1",
				permissionMode: "ask",
				connectorKeys: [key],
			});
			const out = parse(await run(AGENT_START_TOOL_NAME, { prompt: "Go" }));
			const row = await collections.codeSessionConnectors.findOne({
				userId: person.user._id,
				deviceId,
				sessionId: out.sessionId as string,
			});
			expect(row?.keys).toEqual([key]);
		} finally {
			await collections.mcpConnectors.deleteOne({ _id: connector._id });
			await collections.codeSessionConnectors.deleteMany({ userId: person.user._id });
		}
	});

	it("falls back to Ask when the model names a target other than the profile's", async () => {
		const projectId = await projectWithConversation();
		await saveProjectAgentProfile(projectId, person.user._id, {
			deviceId,
			workspaceId: "ws1",
			permissionMode: "allow",
		});
		machine.model.workspaces.push({
			id: "ws2",
			name: "docs",
			path: "/work/docs",
			createdAt: new Date().toISOString(),
			isGitRepo: true,
		});
		const out = parse(await run(AGENT_START_TOOL_NAME, { prompt: "x", workspaceId: "ws2" }));
		expect(machine.model.sessions.find((s) => s.id === out.sessionId)).toMatchObject({
			workspaceId: "ws2",
			permissionMode: "ask",
		});
	});

	it("asks the model to choose when there is no profile and no target", async () => {
		expect(errorOf(await run(AGENT_START_TOOL_NAME, { prompt: "x" }))).toContain("agent_sessions");
		expect(ops("session.create")).toHaveLength(0);
	});

	it("refuses another user's machine as if it did not exist, and touches nothing on it", async () => {
		const other = await createTestUser();
		const theirs = await pairFor(other);
		const refusal = errorOf(
			await run(AGENT_START_TOOL_NAME, {
				deviceId: theirs.deviceId,
				workspaceId: "ws1",
				prompt: "hello",
			})
		);
		expect(refusal).toContain("No such machine");
		expect(ops("session.create", theirs)).toHaveLength(0);
		expect(ops("session.prompt", theirs)).toHaveLength(0);
		// ... exactly the words for an id that is not a device at all.
		expect(
			errorOf(
				await run(AGENT_START_TOOL_NAME, {
					deviceId: new ObjectId().toString(),
					workspaceId: "ws1",
					prompt: "hello",
				})
			)
		).toBe(refusal);
		expect(await auditRows()).toEqual([]);
	});

	it("refuses an offline machine, clearly, and sends nothing", async () => {
		await machine.close();
		await waitOffline(deviceId);
		expect(
			errorOf(await run(AGENT_START_TOOL_NAME, { deviceId, workspaceId: "ws1", prompt: "x" }))
		).toContain("offline");
	});

	it("refuses a workspace the machine does not have", async () => {
		expect(
			errorOf(await run(AGENT_START_TOOL_NAME, { deviceId, workspaceId: "nope", prompt: "x" }))
		).toContain("workspace is not on this computer");
		expect(ops("session.create")).toHaveLength(0);
	});

	it("refuses a model the machine may not drive", async () => {
		expect(
			errorOf(
				await run(AGENT_START_TOOL_NAME, {
					deviceId,
					workspaceId: "ws1",
					prompt: "x",
					modelId: "opencode/free-thing",
				})
			)
		).toContain("--allow-free-models");
	});

	it("refuses with the sign-in hint when the sign-in is older than 7 days, and does nothing", async () => {
		await collections.sessions.updateOne(
			{ sessionId: person.session.sessionId },
			{ $set: { authTime: new Date(Date.now() - 8 * 24 * 3600 * 1000) } }
		);
		for (const name of [
			AGENT_SESSIONS_TOOL_NAME,
			AGENT_START_TOOL_NAME,
			AGENT_SEND_TOOL_NAME,
			AGENT_READ_TOOL_NAME,
		]) {
			expect(
				errorOf(await run(name, { deviceId, workspaceId: "ws1", sessionId: "s", prompt: "x" }))
			).toContain("sign in again");
		}
		expect(ops("session.create")).toHaveLength(0);
		// A session with no sign-in time at all is stale too, never exempt.
		await collections.sessions.updateOne(
			{ sessionId: person.session.sessionId },
			{ $unset: { authTime: "" } }
		);
		expect(errorOf(await run(AGENT_SESSIONS_TOOL_NAME, {}))).toContain("sign in again");
	});

	it("writes an audit row with the conversation id, never the prompt", async () => {
		const out = parse(
			await run(AGENT_START_TOOL_NAME, { deviceId, workspaceId: "ws1", prompt: "secret plan" })
		);
		const rows = await auditRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "agent.start",
			workspaceId: "ws1",
			sessionId: out.sessionId,
			conversationId: conversationId.toString(),
			mode: "ask",
			outcome: "ok",
		});
		expect(rows[0].userId.equals(person.user._id)).toBe(true);
		expect(rows[0].deviceId.toString()).toBe(deviceId);
		expect(JSON.stringify(rows[0])).not.toContain("secret plan");
	});

	it("is withheld when /code is off", async () => {
		flags.codeAgents = false;
		expect(
			errorOf(await run(AGENT_START_TOOL_NAME, { deviceId, workspaceId: "ws1", prompt: "x" }))
		).toContain("switched off");
	});
});

describe("agent_send", () => {
	it("sends to an idle session and leaves its own permission word alone", async () => {
		const session = addSession(machine, { permissionMode: "allow", modeId: "build" });
		const outcome = await run(AGENT_SEND_TOOL_NAME, {
			deviceId,
			sessionId: session.id,
			prompt: "Now add tests",
		});
		expect(parse(outcome)).toMatchObject({ prompted: true, sessionId: session.id });
		expect(ops("session.prompt")).toHaveLength(1);
		expect(ops("session.setPermissionMode")).toHaveLength(0);
		expect(ops("session.setMode")).toHaveLength(0);
		expect(machine.model.sessions.find((s) => s.id === session.id)?.permissionMode).toBe("allow");
		expect("extraUpdates" in outcome && outcome.extraUpdates?.[0]).toMatchObject({
			type: MessageUpdateType.AgentSession,
			action: "prompted",
			sessionId: session.id,
			title: "Existing work",
			labels: { device: "build box", workspace: "repo" },
		});
		const [row] = await auditRows();
		expect(row).toMatchObject({
			action: "agent.send",
			sessionId: session.id,
			conversationId: conversationId.toString(),
			outcome: "ok",
		});
	});

	it("refuses a working session, and one waiting on the user, and sends nothing", async () => {
		const working = addSession(machine, { status: "busy" });
		const waiting = addSession(machine, { pendingPermissions: 1 });
		const a = errorOf(
			await run(AGENT_SEND_TOOL_NAME, { deviceId, sessionId: working.id, prompt: "x" })
		);
		expect(a).toContain("still working");
		expect(a).toContain("agent_read");
		expect(
			errorOf(await run(AGENT_SEND_TOOL_NAME, { deviceId, sessionId: waiting.id, prompt: "x" }))
		).toContain("waiting for an approval");
		expect(ops("session.prompt")).toHaveLength(0);
		expect(await auditRows()).toEqual([]);
	});

	it("refuses a session id that is not on the caller's machine, and another user's machine", async () => {
		const other = await createTestUser();
		const theirs = await pairFor(other);
		const theirSession = addSession(theirs);
		// Their session id on my machine: not there.
		expect(
			errorOf(
				await run(AGENT_SEND_TOOL_NAME, { deviceId, sessionId: theirSession.id, prompt: "x" })
			)
		).toContain("No such session");
		// Their device id: as if it did not exist.
		expect(
			errorOf(
				await run(AGENT_SEND_TOOL_NAME, {
					deviceId: theirs.deviceId,
					sessionId: theirSession.id,
					prompt: "x",
				})
			)
		).toContain("No such machine");
		expect(ops("session.prompt", theirs)).toHaveLength(0);
		expect(ops("session.prompt")).toHaveLength(0);
	});

	it("refuses a subagent's session", async () => {
		const parent = addSession(machine);
		const child = addSession(machine, { parentId: parent.id });
		expect(
			errorOf(await run(AGENT_SEND_TOOL_NAME, { deviceId, sessionId: child.id, prompt: "x" }))
		).toContain("No such session");
	});

	it("refuses an offline machine", async () => {
		const session = addSession(machine);
		await machine.close();
		await waitOffline(deviceId);
		expect(
			errorOf(await run(AGENT_SEND_TOOL_NAME, { deviceId, sessionId: session.id, prompt: "x" }))
		).toContain("offline");
	});
});

describe("agent_read", () => {
	it("returns the state, open approvals and questions and the last answer", async () => {
		const session = addSession(machine, { pendingPermissions: 1 });
		say(machine, session.id, "user", "do it");
		say(machine, session.id, "assistant", "first thing");
		say(machine, session.id, "assistant", "Done: 3 files changed.");
		const transcript = machine.model.transcripts.get(session.id);
		if (!transcript) throw new Error("no transcript");
		transcript.permissions.push({
			id: "p1",
			sessionId: session.id,
			tool: "bash",
			title: "Run npm test",
			patterns: ["npm test"],
			metadata: {},
			always: [],
		});
		transcript.questions = [{ id: "q1", questions: [{ question: "Which branch?", options: [] }] }];
		const out = parse(await run(AGENT_READ_TOOL_NAME, { deviceId, sessionId: session.id }));
		expect(out).toMatchObject({
			state: "needs-you",
			lastAnswer: "Done: 3 files changed.",
			openApprovals: [{ tool: "bash", title: "Run npm test" }],
			openQuestions: ["Which branch?"],
		});
		expect(out).not.toHaveProperty("transcript");
	});

	it("bounds the last answer and the transcript, newest first, and says so", async () => {
		const session = addSession(machine);
		say(machine, session.id, "assistant", "OLDEST " + "a".repeat(MAX_TRANSCRIPT_CHARS));
		say(machine, session.id, "user", "middle question");
		say(machine, session.id, "assistant", "NEWEST " + "b".repeat(MAX_LAST_ANSWER_CHARS * 2));
		const out = parse(
			await run(AGENT_READ_TOOL_NAME, { deviceId, sessionId: session.id, full: true })
		);
		expect((out.lastAnswer as string).length).toBeLessThanOrEqual(MAX_LAST_ANSWER_CHARS + 1);
		const transcript = out.transcript as string;
		expect(transcript.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
		expect(transcript.indexOf("NEWEST")).toBeLessThan(transcript.indexOf("middle question"));
		expect(transcript).not.toContain("OLDEST");
		expect(out.transcriptNote).toContain("left out");
	});

	it("is a read: no prompt, no mode or permission change", async () => {
		const session = addSession(machine);
		parse(await run(AGENT_READ_TOOL_NAME, { deviceId, sessionId: session.id }));
		for (const op of ["session.prompt", "session.setPermissionMode", "session.setMode"]) {
			expect(ops(op)).toHaveLength(0);
		}
	});

	it("refuses another user's device and session ids as if they did not exist", async () => {
		const other = await createTestUser();
		const theirs = await pairFor(other);
		const theirSession = addSession(theirs);
		expect(
			errorOf(
				await run(AGENT_READ_TOOL_NAME, { deviceId: theirs.deviceId, sessionId: theirSession.id })
			)
		).toContain("No such machine");
		expect(
			errorOf(await run(AGENT_READ_TOOL_NAME, { deviceId, sessionId: theirSession.id }))
		).toContain("No such session");
		expect(theirs.opLog.filter((o) => o.op.startsWith("session."))).toEqual([]);
	});

	it("says an offline machine is offline rather than failing", async () => {
		const session = addSession(machine);
		await machine.close();
		await waitOffline(deviceId);
		expect(
			parse(await run(AGENT_READ_TOOL_NAME, { deviceId, sessionId: session.id }))
		).toMatchObject({
			state: "offline",
		});
	});
});

describe("offering the tools", () => {
	const names = (agentSessions?: object, extra: object = {}) =>
		getEnabledBuiltinTools({
			conv: { _id: new ObjectId(), webSearch: false },
			toolsEnabled: true,
			...(agentSessions ? { agentSessions } : {}),
			...extra,
		}).map((t) => t.name);

	it("offers the four only when the turn resolved them, and agent_read carries the untrusted guard", () => {
		for (const name of [
			AGENT_SESSIONS_TOOL_NAME,
			AGENT_START_TOOL_NAME,
			AGENT_SEND_TOOL_NAME,
			AGENT_READ_TOOL_NAME,
		]) {
			expect(names({})).toContain(name);
			expect(names()).not.toContain(name);
		}
		expect(names({}, { toolsEnabled: false })).not.toContain(AGENT_START_TOOL_NAME);
		expect(EXTERNAL_BUILTIN_TOOLS.has(AGENT_READ_TOOL_NAME)).toBe(true);
		const tools = getEnabledBuiltinTools({
			conv: { _id: new ObjectId(), webSearch: false },
			toolsEnabled: true,
			agentSessions: {},
		});
		const read = tools.find((t) => t.name === AGENT_READ_TOOL_NAME);
		expect(read?.definition.function.description?.endsWith(UNTRUSTED_DESCRIPTION_SUFFIX)).toBe(
			true
		);
		const start = tools.find((t) => t.name === AGENT_START_TOOL_NAME);
		expect(start?.definition.function.description?.endsWith(UNTRUSTED_DESCRIPTION_SUFFIX)).toBe(
			false
		);
	});

	it("tells the model the project's default target, and that results are read later", () => {
		const tool = createAgentSessionBuiltins({
			profile: {
				deviceId: "d1",
				workspaceId: "w1",
				permissionMode: "ask",
				labels: { device: "build box", workspace: "repo" },
				updatedAt: new Date().toISOString(),
			},
		}).find((t) => t.name === AGENT_START_TOOL_NAME);
		expect(tool?.definition.function.description).toContain('"repo" on "build box"');
		expect(tool?.preprompt).toContain("never wait");
	});

	it("is resolved for a person with /code, a paired machine, and nothing otherwise", async () => {
		expect(await agentSessionsFor(person.locals, undefined)).toEqual({ profile: null });
		flags.codeAgents = false;
		expect(await agentSessionsFor(person.locals, undefined)).toBeUndefined();
		flags.codeAgents = true;
		const stranger = await createTestUser();
		expect(await agentSessionsFor(stranger.locals, undefined)).toBeUndefined();
		expect(
			await agentSessionsFor({ ...person.locals, user: undefined }, undefined)
		).toBeUndefined();
	});
});

async function projectWithConversation(): Promise<ObjectId> {
	const projectId = new ObjectId();
	await collections.projects.insertOne({
		_id: projectId,
		userId: person.user._id,
		name: "Matter",
		description: "",
		instructions: "",
		knowledgeBaseIds: [],
		shares: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	await collections.conversations.updateOne({ _id: conversationId }, { $set: { projectId } });
	return projectId;
}

describe("the approval click (resume)", () => {
	async function park(
		tool: string,
		args: Record<string, unknown>,
		action: "accept" | "decline",
		sessionId = person.session.sessionId
	) {
		const elicitationId = randomUUID();
		await collections.mcpElicitations.insertOne({
			_id: new ObjectId(),
			elicitationId,
			conversationId,
			status: "resolved",
			action,
			content: { scope: "once" },
			request: {
				elicitationId,
				server: tool,
				mode: "form",
				message: `The assistant wants to call ${tool}.`,
				fields: [],
				toolApproval: { tool, args },
			},
			pending: {
				kind: "tool-approval",
				tool,
				args,
				queue: [],
				messageId: "m1",
				toolCallId: "c1",
				toolUuid: "u1",
				userId: person.user._id,
				sessionId,
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		return elicitationId;
	}

	afterEach(async () => {
		await collections.mcpElicitations.deleteMany({});
	});

	it("starts the session as the person on accept and keeps the card with the result", async () => {
		const id = await park(
			AGENT_START_TOOL_NAME,
			{ deviceId, workspaceId: "ws1", prompt: "Look at the failing build" },
			"accept"
		);
		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: id });
		expect(ops("session.create")).toHaveLength(1);
		expect(ops("session.prompt")).toHaveLength(1);
		const result = outcome.updates.find((u) => "subtype" in u && u.subtype === "result");
		expect(JSON.stringify(result)).toContain("started");
		expect(outcome.updates.find((u) => u.type === MessageUpdateType.AgentSession)).toMatchObject({
			action: "started",
			deviceId,
			workspaceId: "ws1",
		});
		expect((await auditRows())[0]).toMatchObject({
			action: "agent.start",
			conversationId: conversationId.toString(),
		});
	});

	it("sends nothing when the person declines", async () => {
		const id = await park(
			AGENT_START_TOOL_NAME,
			{ deviceId, workspaceId: "ws1", prompt: "x" },
			"decline"
		);
		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: id });
		expect(ops("session.create")).toHaveLength(0);
		expect(outcome.updates.find((u) => "subtype" in u && u.subtype === "error")).toMatchObject({
			message: expect.stringContaining("declined"),
		});
	});

	it("re-checks the sign-in at the click: a stale one sends nothing and says to sign in again", async () => {
		await collections.sessions.updateOne(
			{ sessionId: person.session.sessionId },
			{ $set: { authTime: new Date(Date.now() - 9 * 24 * 3600 * 1000) } }
		);
		const session = addSession(machine);
		const id = await park(
			AGENT_SEND_TOOL_NAME,
			{ deviceId, sessionId: session.id, prompt: "x" },
			"accept"
		);
		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: id });
		expect(ops("session.prompt")).toHaveLength(0);
		expect(outcome.updates.find((u) => "subtype" in u && u.subtype === "error")).toMatchObject({
			message: expect.stringContaining("sign in again"),
		});
	});
});
