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
import { acceptMachineConnection } from "$lib/server/code/machines";
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

/** Text that grew is a delta; text the backend replaced (not an extension) cannot be a
 * delta, so the stream resets the client and re-sends the session whole. */
describe("the stream corrects text the backend replaced", () => {
	it("resets with the full text on a non-prefix replacement, not on a prefix extension", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(deviceId);
		const { agent } = await createSession(deviceId, workspace.id);

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
		await readFramesUntil(reader, (d) => (d as { type?: string }).type === "historyDone");

		const part = (id: string, text: string) =>
			({
				kind: "part",
				part: { id, messageId: "m1", role: "assistant", type: "text", text },
			}) as const;
		machine.pushEvent(agent.id, part("p1", "Hel"));
		await readFramesUntil(reader, (d) => JSON.stringify(d).includes("Hel"));

		// A prefix extension and a sentinel: no reset in between.
		machine.pushEvent(agent.id, part("p1", "Hello"));
		machine.pushEvent(agent.id, part("p9", "sentinel"));
		const seen: unknown[] = [];
		await readFramesUntil(reader, (d) => {
			seen.push(d);
			return JSON.stringify(d).includes("sentinel");
		});
		expect(seen.some((d) => (d as { type?: string }).type === "reset")).toBe(false);

		// The backend replaces the text: the stream resets and re-sends everything.
		machine.model.transcripts.set(agent.id, {
			messages: [
				{
					message: { id: "m1", role: "assistant" },
					parts: [
						{ id: "p1", messageId: "m1", role: "assistant", type: "text", text: "Goodbye world" },
					],
				},
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		});
		machine.pushEvent(agent.id, part("p1", "Goodbye world"));
		const frames: unknown[] = [];
		await readFramesUntil(reader, (d) => {
			frames.push(d);
			return (d as { type?: string }).type === "historyDone";
		});
		const types = frames.map((d) => (d as { type?: string }).type);
		expect(types[0]).toBe("reset");
		expect(types.filter((t) => t === "reset")).toHaveLength(1);
		expect(JSON.stringify(frames)).toContain("Goodbye world");

		controller.abort();
		machine.close();
	});
});
