/**
 * Subagent approvals and questions surfacing in the parent view: the
 * root-keyed subscription in `machines.ts`, the labelled fold on the SSE
 * bridge, and the reply routes forwarding to the child's own request.
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
import { testRequest, TEST_ORIGIN } from "$lib/server/__tests__/testRequest";
import {
	acceptMachineConnection,
	subscribeSessionEvents,
	subscribeSessionTree,
} from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { FakeMachine } from "../../../../../../tests/fake-machine";
import { GET as forwarderGET, POST as forwarderPOST } from "../[...path]/+server";
import { PATCH as devicesPATCH } from "../devices/+server";
import { GET as streamGET } from "../agents/[id]/stream/+server";

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
			acceptMachineConnection(ws, req, principal);
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
	opts: { method?: string; body?: string; json?: boolean; locals: App.Locals; signal?: AbortSignal }
): Promise<Response> {
	const restPath = urlPath.replace(/^\/api\/v2\/code\//, "").split("?")[0];
	return testRequest(handler, {
		method: opts.method,
		path: urlPath,
		body: opts.body,
		headers: opts.json === false ? { origin: TEST_ORIGIN } : { "content-type": "application/json" },
		locals: opts.locals,
		signal: opts.signal,
		params: { path: restPath },
	});
}

async function connectAndPair(): Promise<FakeMachine> {
	const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
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

async function createWorkspace(
	deviceId: string
): Promise<{ workspace: { id: string; name: string; path: string } }> {
	const res = await forwarder(forwarderPOST, `/api/v2/code/v1/workspaces?device=${deviceId}`, {
		method: "POST",
		body: JSON.stringify({ path: "/repo", title: "repo" }),
		locals: user.locals,
	});
	return parse(res);
}

async function createSession(
	deviceId: string,
	workspaceId: string
): Promise<{ agent: { id: string } }> {
	const res = await forwarder(forwarderPOST, `/api/v2/code/v1/agents?device=${deviceId}`, {
		method: "POST",
		body: JSON.stringify({ workspaceId, provider: "opencode", posture: "plan" }),
		locals: user.locals,
	});
	return parse(res);
}

interface SseFrame {
	id?: string;
	event: string;
	data: string;
}

async function readOneFrame(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs = 10_000
): Promise<SseFrame> {
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (Date.now() > deadline) throw new Error("timed out waiting for an SSE frame");
		const { value, done } = await reader.read();
		if (done) throw new Error("stream ended before a frame arrived");
		buffer += decoder.decode(value, { stream: true });
		const sep = buffer.indexOf("\n\n");
		if (sep === -1) continue;
		const raw = buffer.slice(0, sep);
		buffer = buffer.slice(sep + 2);
		if (raw.startsWith(":")) continue;
		const frame: SseFrame = { event: "message", data: "" };
		for (const line of raw.split("\n")) {
			if (line.startsWith("id: ")) frame.id = line.slice(4);
			else if (line.startsWith("event: ")) frame.event = line.slice(7);
			else if (line.startsWith("data: ")) frame.data = line.slice(6);
		}
		return frame;
	}
}

async function readFramesUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	predicate: (data: unknown) => boolean,
	maxFrames = 30
): Promise<unknown> {
	for (let i = 0; i < maxFrames; i++) {
		const frame = await readOneFrame(reader);
		if (frame.event !== "update") continue;
		const data: unknown = JSON.parse(frame.data);
		if (predicate(data)) return data;
	}
	throw new Error("the expected frame never arrived on the stream");
}

async function readRawFrameUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	predicate: (data: { type?: string }) => boolean,
	maxFrames = 30
): Promise<SseFrame> {
	for (let i = 0; i < maxFrames; i++) {
		const frame = await readOneFrame(reader);
		if (frame.event !== "update") continue;
		if (predicate(JSON.parse(frame.data) as { type?: string })) return frame;
	}
	throw new Error("the expected frame never arrived on the stream");
}

describe("the root-keyed subscription (machines.ts)", () => {
	it("still delivers a subagent's own envelopes to a view watching that subagent", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;

		// The subagent's view subscribes as a tree rooted at itself, while the
		// subagent's envelopes are rooted at its parent.
		const seen: string[] = [];
		const unsub = subscribeSessionTree(deviceId, "child-1", (envelope) => {
			seen.push(`${envelope.sessionId}:${envelope.rootSessionId}`);
		});
		machine.pushEvent("child-1", { kind: "status", status: "busy" }, "parent-1");
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(seen).toEqual(["child-1:parent-1"]);
		unsub();
		machine.close();
	});

	it("fans a child's envelopes out to its root's watchers, and nothing else's", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;

		const seen: string[] = [];
		const unsub = subscribeSessionTree(deviceId, "parent-1", (envelope) => {
			seen.push(`${envelope.sessionId}:${envelope.event.kind}`);
		});
		const otherSeen: string[] = [];
		const unsubOther = subscribeSessionTree(deviceId, "other-root", (envelope) => {
			otherSeen.push(envelope.sessionId);
		});

		machine.pushEvent("child-1", { kind: "status", status: "busy" }, "parent-1");
		machine.pushEvent("parent-1", { kind: "status", status: "busy" }, "parent-1");
		machine.pushEvent("unrelated", { kind: "status", status: "busy" }, "unrelated");
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(seen).toEqual(["child-1:status", "parent-1:status"]);
		expect(otherSeen).toEqual([]);
		unsub();
		unsubOther();
		machine.close();
	});

	it("falls back to the session id for machines that predate rootSessionId", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;

		const seen: string[] = [];
		const unsub = subscribeSessionEvents(deviceId, "child-1", (envelope) => {
			seen.push(envelope.sessionId);
		});
		const treeSeen: string[] = [];
		const unsubTree = subscribeSessionTree(deviceId, "child-1", (envelope) => {
			treeSeen.push(envelope.sessionId);
		});

		// A legacy frame: no rootSessionId on the wire at all.
		machine.ws.send(
			JSON.stringify({
				type: "event",
				sessionId: "child-1",
				epoch: machine.model.epoch,
				seq: 1,
				event: { kind: "status", status: "busy" },
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(seen).toEqual(["child-1"]);
		expect(treeSeen).toEqual(["child-1"]);
		unsub();
		unsubTree();
		machine.close();
	});
});

describe("the parent stream over a session tree", () => {
	it("labels a child's approval with the subagent and keeps its tokens out of the transcript", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(deviceId);
		const { agent } = await createSession(deviceId, workspace.id);

		// The roster names the child, so the bridge can label its cards.
		const now = new Date().toISOString();
		machine.model.sessions.push({
			id: "child-1",
			workspaceId: workspace.id,
			backend: "opencode",
			title: "Researcher",
			status: "busy",
			pendingPermissions: 1,
			modeId: null,
			modelId: null,
			autoAccept: false,
			parentId: agent.id,
			createdAt: now,
			updatedAt: now,
			usage: null,
		});

		const controller = new AbortController();
		const res = await testRequest(streamGET, {
			path: `/api/v2/code/agents/${agent.id}/stream?device=${deviceId}`,
			params: { id: agent.id },
			locals: user.locals,
			signal: controller.signal,
		});
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		expect(reader).toBeTruthy();
		if (!reader) return;

		machine.pushEvent(
			"child-1",
			{
				kind: "permission.asked",
				request: {
					id: "perm-1",
					sessionId: "child-1",
					tool: "bash",
					title: "run tests",
					patterns: [],
					metadata: {},
					always: [],
				},
			},
			agent.id
		);
		const approval = await readFramesUntil(
			reader,
			(data) =>
				typeof data === "object" &&
				data !== null &&
				"type" in data &&
				(data as { type: string }).type === "elicitation"
		);
		const text = JSON.stringify(approval);
		expect(text).toContain("Subagent Researcher: run tests");
		expect(text).toContain("child-1");

		machine.pushEvent(
			"child-1",
			{
				kind: "part",
				part: { id: "p1", messageId: "m1", role: "assistant", type: "text", text: "child tokens" },
			},
			agent.id
		);
		const activity = await readFramesUntil(
			reader,
			(data) =>
				typeof data === "object" &&
				data !== null &&
				"type" in data &&
				(data as { type: string }).type === "childActivity"
		);
		expect(activity).toMatchObject({ type: "childActivity", childId: "child-1" });

		// A subagent's frames carry no SSE id: the client's Last-Event-ID is the
		// watched session's own resume cursor, and a child's seq is not on it.
		machine.pushEvent(
			"child-1",
			{
				kind: "part",
				part: { id: "p2", messageId: "m1", role: "assistant", type: "text", text: "more" },
			},
			agent.id
		);
		const childFrame = await readRawFrameUntil(reader, (data) => data.type === "childActivity");
		expect(childFrame.id).toBeUndefined();
		machine.pushEvent(agent.id, { kind: "status", status: "busy" }, agent.id);
		const parentFrame = await readRawFrameUntil(reader, (data) => data.type !== "childActivity");
		expect(parentFrame.id).toMatch(/^.+:\d+$/);

		controller.abort();
		await reader.cancel().catch(() => {});
		machine.close();
	});
});

describe("the reply routes targeting a child session", () => {
	it("forwards a permission reply to the child's own request", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(deviceId);
		const { agent } = await createSession(deviceId, workspace.id);

		const now = new Date().toISOString();
		machine.model.sessions.push({
			id: "child-1",
			workspaceId: workspace.id,
			backend: "opencode",
			title: "Researcher",
			status: "busy",
			pendingPermissions: 1,
			modeId: null,
			modelId: null,
			autoAccept: false,
			parentId: agent.id,
			createdAt: now,
			updatedAt: now,
			usage: null,
		});
		const replyArgs: unknown[] = [];
		machine.onOp("permission.reply", (args: unknown) => {
			replyArgs.push(args);
			return {};
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/permissions/perm-1?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ decision: "once", childSessionId: "child-1" }),
				locals: user.locals,
			}
		);
		expect(res.status).toBe(200);
		expect(replyArgs).toEqual([{ sessionId: "child-1", requestId: "perm-1", decision: "once" }]);

		machine.close();
	});

	it("404s a permission reply to a child that lives nowhere on this machine", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(deviceId);
		const { agent } = await createSession(deviceId, workspace.id);

		const replyArgs: unknown[] = [];
		machine.onOp("permission.reply", (args: unknown) => {
			replyArgs.push(args);
			return {};
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/permissions/perm-1?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ decision: "once", childSessionId: "no-such-child" }),
				locals: user.locals,
			}
		);
		expect(res.status).toBe(404);
		expect(replyArgs).toHaveLength(0);

		machine.close();
	});

	it("forwards a question answer to the child's own ask", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(deviceId);
		const { agent } = await createSession(deviceId, workspace.id);

		const now = new Date().toISOString();
		machine.model.sessions.push({
			id: "child-1",
			workspaceId: workspace.id,
			backend: "opencode",
			title: "Researcher",
			status: "busy",
			pendingPermissions: 0,
			modeId: null,
			modelId: null,
			autoAccept: false,
			parentId: agent.id,
			createdAt: now,
			updatedAt: now,
			usage: null,
		});
		const replyArgs: unknown[] = [];
		machine.onOp("question.reply", (args: unknown) => {
			replyArgs.push(args);
			return {};
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/questions/q-1?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ decision: "accept", answers: [["A"]], childSessionId: "child-1" }),
				locals: user.locals,
			}
		);
		expect(res.status).toBe(200);
		expect(replyArgs).toEqual([
			{ sessionId: "child-1", requestId: "q-1", decision: "answer", answers: [["A"]] },
		]);

		machine.close();
	});
});
