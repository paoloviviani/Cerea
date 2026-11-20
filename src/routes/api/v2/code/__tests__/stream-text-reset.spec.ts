/**
 * The stream's correction of text the backend replaced (a non-prefix `part`
 * event for a part already routed): one `reset` + fresh snapshot +
 * `historyDone`, coalesced per stream window, with subagent cards re-seeded.
 * Driven end to end against a fake machine over a real WebSocket, like
 * `subagent-approvals.spec.ts`.
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
import { acceptMachineConnection } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { OpError } from "$lib/types/machineProtocol";
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

const WINDOW_MS = 5000;

type Frame = { type?: string };
const typeOf = (d: unknown) => (d as Frame).type;

async function openStream(machine: FakeMachine) {
	const deviceId = machine.deviceId as string;
	const { workspace } = await createWorkspace(deviceId);
	const { agent } = await createSession(deviceId, workspace.id);
	return { agent, workspace, deviceId };
}

async function watch(agentId: string, deviceId: string) {
	const controller = new AbortController();
	const res = await testRequest(streamGET, {
		path: `/api/v2/code/agents/${agentId}/stream?device=${deviceId}`,
		params: { id: agentId },
		locals: user.locals,
		signal: controller.signal,
	});
	expect(res.status).toBe(200);
	const reader = res.body?.getReader();
	if (!reader) throw new Error("no body");
	await readFramesUntil(reader, (d) => typeOf(d) === "historyDone");
	return { reader, controller };
}

const part = (id: string, text: string) =>
	({ kind: "part", part: { id, messageId: "m1", role: "assistant", type: "text", text } }) as const;

function setTranscript(machine: FakeMachine, agentId: string, texts: Record<string, string>) {
	machine.model.transcripts.set(agentId, {
		messages: [
			{
				message: { id: "m1", role: "assistant", createdAt: new Date().toISOString() },
				parts: Object.entries(texts).map(([id, text]) => ({
					id,
					messageId: "m1",
					role: "assistant" as const,
					type: "text" as const,
					text,
				})),
			},
		],
		permissions: [],
		status: "idle",
		usage: null,
		todos: [],
	});
}

/** Frames until the sentinel part's text is seen. */
async function framesThroughSentinel(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	sentinel: string
): Promise<unknown[]> {
	const seen: unknown[] = [];
	await readFramesUntil(
		reader,
		(d) => {
			seen.push(d);
			return JSON.stringify(d).includes(sentinel);
		},
		60
	);
	return seen;
}

/** Text that grew is a delta; text the backend replaced (not an extension) cannot be a
 * delta, so the stream resets the client and re-sends the session whole. */
describe("the stream corrects text the backend replaced", () => {
	it("resets with the full text on a non-prefix replacement, not on a prefix extension", async () => {
		const machine = await connectAndPair();
		const { agent, deviceId } = await openStream(machine);
		const { reader, controller } = await watch(agent.id, deviceId);

		machine.pushEvent(agent.id, part("p1", "Hel"));
		await readFramesUntil(reader, (d) => JSON.stringify(d).includes("Hel"));

		machine.pushEvent(agent.id, part("p1", "Hello"));
		machine.pushEvent(agent.id, part("p9", "sentinel"));
		const seen = await framesThroughSentinel(reader, "sentinel");
		expect(seen.some((d) => typeOf(d) === "reset")).toBe(false);

		setTranscript(machine, agent.id, { p1: "Goodbye world" });
		machine.pushEvent(agent.id, part("p1", "Goodbye world"));
		const frames: unknown[] = [];
		await readFramesUntil(reader, (d) => {
			frames.push(d);
			return typeOf(d) === "historyDone";
		});
		const types = frames.map(typeOf);
		expect(types[0]).toBe("reset");
		expect(types.filter((t) => t === "reset")).toHaveLength(1);
		expect(JSON.stringify(frames)).toContain("Goodbye world");

		controller.abort();
		machine.close();
	});

	it("skips what the fresh snapshot already covers and coalesces many divergences into one reset", async () => {
		const machine = await connectAndPair();
		const { agent, deviceId } = await openStream(machine);
		const { reader, controller } = await watch(agent.id, deviceId);

		for (const id of ["a", "b", "c"]) machine.pushEvent(agent.id, part(id, `${id}-old`));
		await framesThroughSentinel(reader, "c-old");

		setTranscript(machine, agent.id, { a: "a-new", b: "b-new", c: "c-new" });
		for (const id of ["a", "b", "c"]) machine.pushEvent(agent.id, part(id, `${id}-new`));
		// a delta already inside the snapshot's cursor: its envelope is skipped
		machine.pushEvent(agent.id, {
			kind: "delta",
			messageId: "m1",
			partId: "a",
			role: "assistant",
			field: "text",
			delta: "COVERED",
		});
		const frames: unknown[] = [];
		await readFramesUntil(reader, (d) => {
			frames.push(d);
			return typeOf(d) === "historyDone";
		});
		// whatever else was buffered is covered: the sentinel, pushed after, is the next thing
		machine.pushEvent(agent.id, part("z", "sentinel"));
		frames.push(...(await framesThroughSentinel(reader, "sentinel")));
		expect(frames.filter((d) => typeOf(d) === "reset")).toHaveLength(1);
		expect(JSON.stringify(frames)).not.toContain("COVERED");

		controller.abort();
		machine.close();
	});

	it("corrects a divergence that fell inside the window once it ends", async () => {
		const machine = await connectAndPair();
		const { agent, deviceId } = await openStream(machine);
		const { reader, controller } = await watch(agent.id, deviceId);

		machine.pushEvent(agent.id, part("a", "a-old"));
		machine.pushEvent(agent.id, part("b", "b-old"));
		await framesThroughSentinel(reader, "b-old");

		setTranscript(machine, agent.id, { a: "a-new", b: "b-old" });
		machine.pushEvent(agent.id, part("a", "a-new"));
		await readFramesUntil(reader, (d) => typeOf(d) === "historyDone");

		// inside the window: held, then corrected when it ends
		setTranscript(machine, agent.id, { a: "a-new", b: "b-newer" });
		machine.pushEvent(agent.id, part("b", "b-newer"));
		const started = Date.now();
		const frames: unknown[] = [];
		await readFramesUntil(reader, (d) => {
			frames.push(d);
			return typeOf(d) === "historyDone";
		});
		expect(Date.now() - started).toBeGreaterThan(WINDOW_MS / 2);
		expect(frames.map(typeOf)[0]).toBe("reset");
		expect(JSON.stringify(frames)).toContain("b-newer");

		controller.abort();
		machine.close();
	}, 30_000);

	it("keeps a waiting subagent's approval card across a reset", async () => {
		const machine = await connectAndPair();
		const { agent, workspace, deviceId } = await openStream(machine);
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
			parentId: agent.id,
			createdAt: now,
			updatedAt: now,
			usage: null,
		});
		machine.model.transcripts.set("child-1", {
			messages: [],
			permissions: [
				{
					id: "perm-1",
					sessionId: "child-1",
					tool: "bash",
					title: "run tests",
					patterns: [],
					metadata: {},
					always: [],
				},
			],
			status: "busy",
			usage: null,
			todos: [],
		});
		const { reader, controller } = await (async () => {
			const c = new AbortController();
			const res = await testRequest(streamGET, {
				path: `/api/v2/code/agents/${agent.id}/stream?device=${deviceId}`,
				params: { id: agent.id },
				locals: user.locals,
				signal: c.signal,
			});
			const r = res.body?.getReader();
			if (!r) throw new Error("no body");
			const opening = await readFramesUntil(r, (d) => typeOf(d) === "historyDone");
			void opening;
			return { reader: r, controller: c };
		})();

		machine.pushEvent(agent.id, part("p1", "old"));
		await readFramesUntil(reader, (d) => JSON.stringify(d).includes("old"));
		setTranscript(machine, agent.id, { p1: "new" });
		machine.pushEvent(agent.id, part("p1", "new"));
		const frames: unknown[] = [];
		await readFramesUntil(reader, (d) => {
			frames.push(d);
			return typeOf(d) === "historyDone";
		});
		expect(frames.map(typeOf)[0]).toBe("reset");
		const card = frames.find((d) => typeOf(d) === "elicitation");
		expect(JSON.stringify(card)).toContain("Subagent Researcher: run tests");

		controller.abort();
		machine.close();
	});

	it("carries on with the old behaviour when the re-sync fails", async () => {
		const machine = await connectAndPair();
		const { agent, deviceId } = await openStream(machine);
		const { reader, controller } = await watch(agent.id, deviceId);

		machine.pushEvent(agent.id, part("p1", "old"));
		await readFramesUntil(reader, (d) => JSON.stringify(d).includes("old"));
		machine.onOp("session.sync", () => {
			throw new OpError("unavailable", "not connected");
		});
		machine.pushEvent(agent.id, part("p1", "different"));
		machine.pushEvent(agent.id, part("p9", "sentinel"));
		const frames = await framesThroughSentinel(reader, "sentinel");
		expect(frames.some((d) => typeOf(d) === "reset")).toBe(false);

		controller.abort();
		machine.close();
	});

	it("does not reset for a subagent's diverging part", async () => {
		const machine = await connectAndPair();
		const { agent, deviceId } = await openStream(machine);
		const { reader, controller } = await watch(agent.id, deviceId);

		machine.pushEvent("child-1", part("cp", "child old"), agent.id);
		machine.pushEvent("child-1", part("cp", "something else"), agent.id);
		machine.pushEvent(agent.id, part("p9", "sentinel"));
		const frames = await framesThroughSentinel(reader, "sentinel");
		expect(frames.some((d) => typeOf(d) === "reset")).toBe(false);

		controller.abort();
		machine.close();
	});
});
