/**
 * The older-transcript page (`GET /api/v2/code/v1/agents/:id/history`, §6
 * `session.history`) over a live machine link: the forwarder maps the
 * browser path to the one machine op, validates the page cursor, converts
 * the page with the same per-message code path the snapshot uses, and maps
 * the machine's `unsupported` to the 404 the view reads as "nothing pages".
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
import { testRequest } from "$lib/server/__tests__/testRequest";
import { acceptMachineConnection } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { FakeMachine } from "../../../../../../tests/fake-machine";
import { GET as forwarderGET, POST as forwarderPOST } from "../[...path]/+server";
import { PATCH as devicesPATCH } from "../devices/+server";
import { GET as streamGET } from "../agents/[id]/stream/+server";
import { snapshotToUpdates } from "$lib/server/code/machineTimeline";
import { OpError, type Transcript } from "$lib/types/machineProtocol";

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
	handler: typeof forwarderGET | typeof forwarderPOST,
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

async function connectAndPair(): Promise<FakeMachine> {
	const machine = new FakeMachine(
		`ws://127.0.0.1:${port}/api/v2/code/machine`,
		{},
		{
			backends: [
				{
					id: "opencode",
					version: "9.9.9",
					capabilities: {
						diff: true,
						children: true,
						usage: true,
						compact: true,
						images: true,
						files: true,
						worktrees: false,
						questions: true,
						historyPaging: true,
					},
				},
			],
		}
	);
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

async function createSession(machine: FakeMachine, deviceId: string): Promise<string> {
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

interface SseFrame {
	id?: string;
	event: string;
	data: string;
}

/** Read from the SSE stream until one full `\n\n`-terminated frame is
 * available, and return it parsed. Heartbeats (`: heartbeat`) are skipped. */
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
		if (raw.startsWith(":")) continue; // heartbeat comment
		const frame: SseFrame = { event: "message", data: "" };
		for (const line of raw.split("\n")) {
			if (line.startsWith("id: ")) frame.id = line.slice(4);
			else if (line.startsWith("event: ")) frame.event = line.slice(7);
			else if (line.startsWith("data: ")) frame.data = line.slice(6);
		}
		return frame;
	}
}

/** One older page: a user prompt, then an answer with a completed tool
 * call and its result — the card a page boundary must never split. */
function pageMessages(): Transcript["messages"] {
	return [
		{
			message: {
				id: "msg_u_old",
				role: "user",
				createdAt: new Date(1000).toISOString(),
				clientMessageId: "c_old",
			},
			parts: [
				{
					id: "part_u_old",
					messageId: "msg_u_old",
					role: "user",
					type: "text",
					text: "an older prompt",
				},
			],
		},
		{
			message: {
				id: "msg_a_old",
				role: "assistant",
				createdAt: new Date(2000).toISOString(),
			},
			parts: [
				{
					id: "part_a_old",
					messageId: "msg_a_old",
					role: "assistant",
					type: "text",
					text: "an older answer",
				},
				{
					id: "part_t_old",
					messageId: "msg_a_old",
					role: "assistant",
					type: "tool",
					callId: "call_old",
					tool: "bash",
					status: "completed",
					input: { command: "ls" },
					output: "a.txt",
				},
			],
		},
	];
}

describe("GET /api/v2/code/v1/agents/:id/history", () => {
	it("forwards sessionId/before/limit to the one machine op, and answers the page", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(machine, deviceId);
		const messages = pageMessages();
		machine.onOp("session.history", () => ({
			messages,
			hasMore: true,
			before: "msg_u_old",
		}));

		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/agents/${sessionId}/history?device=${deviceId}&before=msg_u_new&limit=40`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(200);
		const body = await parse<{ updates: unknown[]; hasMore: boolean; before: string }>(res);
		expect(body.hasMore).toBe(true);
		expect(body.before).toBe("msg_u_old");
		const asked = machine.opLog.find((entry) => entry.op === "session.history");
		expect(asked?.args).toMatchObject({ sessionId, before: "msg_u_new", limit: 40 });

		// The frames are the message frames: a user frame, boundaries, a
		// token and a paired call/result — and nothing else rides a page.
		const types = body.updates.map((update) => (update as { type: string }).type);
		expect(types).toContain("user");
		expect(types).toContain("messageBoundary");
		expect(types.filter((type) => type === "tool")).toHaveLength(2);
		for (const type of types) {
			expect(["user", "messageBoundary", "stream", "tool"]).toContain(type);
		}
		// The tool call and its result pair on the same card.
		const tools = body.updates.filter(
			(update) => (update as { type: string }).type === "tool"
		) as Array<{
			subtype: string;
			uuid: string;
		}>;
		expect(tools.map((tool) => tool.subtype).sort()).toEqual(["call", "result"]);
		expect(new Set(tools.map((tool) => tool.uuid)).size).toBe(1);
	});

	it("converts a page exactly as the snapshot converts the same messages", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(machine, deviceId);
		const messages = pageMessages();
		machine.onOp("session.history", () => ({ messages, hasMore: false }));

		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/agents/${sessionId}/history?device=${deviceId}&before=msg_u_new&limit=40`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(200);
		const body = await parse<{ updates: unknown[]; hasMore: boolean }>(res);

		const snapshot = snapshotToUpdates(
			{ messages, permissions: [], status: "idle", usage: null, todos: [] },
			undefined,
			sessionId
		);
		// The snapshot appends one trailing turn-state frame to the messages
		// below; the page is the messages' frames alone.
		expect(body.updates).toEqual(snapshot.slice(0, body.updates.length));
	});

	it("refuses a missing before and an out-of-range limit before any machine is asked", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(machine, deviceId);
		for (const query of ["limit=40", "before=msg_1&limit=0", "before=msg_1&limit=501"]) {
			const res = await forwarder(
				forwarderGET,
				`/api/v2/code/v1/agents/${sessionId}/history?device=${deviceId}&${query}`,
				{ locals: user.locals }
			);
			expect(res.status, query).toBe(400);
		}
		expect(machine.opLog.some((entry) => entry.op === "session.history")).toBe(false);
	});

	it("maps the machine's unsupported to 404: nothing pages without the capability", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(machine, deviceId);
		machine.onOp("session.history", () => {
			throw new OpError("unsupported", "backend fake has no historyPaging capability");
		});
		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/agents/${sessionId}/history?device=${deviceId}&before=msg_1&limit=40`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(404);
	});
});

describe("the stream's newest page over a live machine link", () => {
	it("asks a paging machine for the newest page, and emits its paging facts before historyDone", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(machine, deviceId);
		// 46 messages: the newest 40 arrive, with 6 behind them.
		const messages: Transcript["messages"] = [];
		for (let i = 1; i <= 23; i += 1) {
			messages.push({
				message: { id: `msg_u_${i}`, role: "user", createdAt: new Date(i * 1000).toISOString() },
				parts: [
					{
						id: `part_u_${i}`,
						messageId: `msg_u_${i}`,
						role: "user",
						type: "text",
						text: `prompt ${i}`,
					},
				],
			});
			messages.push({
				message: {
					id: `msg_a_${i}`,
					role: "assistant",
					createdAt: new Date(i * 1000 + 1).toISOString(),
				},
				parts: [
					{
						id: `part_a_${i}`,
						messageId: `msg_a_${i}`,
						role: "assistant",
						type: "text",
						text: `answer ${i}`,
					},
				],
			});
		}
		machine.model.transcripts.set(sessionId, {
			messages,
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		});

		const controller = new AbortController();
		const res = await testRequest(streamGET, {
			path: `/api/v2/code/agents/${sessionId}/stream?device=${deviceId}`,
			params: { id: sessionId },
			locals: user.locals,
			signal: controller.signal,
		});
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		expect(reader).toBeTruthy();
		if (!reader) return;

		// The machine was asked for the newest page only: an older galopin
		// never sees the field and answers the whole log instead.
		const asked = machine.opLog.find((entry) => entry.op === "session.sync");
		expect(asked?.args).toMatchObject({ sessionId, limit: 40 });

		// The snapshot's tail arrives (the newest answer), then the paging
		// facts, then the first-paint gate opens.
		const seen: string[] = [];
		let meta: { hasMore: boolean; before?: string } | null = null;
		for (;;) {
			const frame = await readOneFrame(reader);
			expect(frame.event).toBe("update");
			const parsed = JSON.parse(frame.data) as {
				type: string;
				hasMore?: boolean;
				before?: string;
			};
			seen.push(parsed.type);
			if (parsed.type === "historyMeta" && typeof parsed.hasMore === "boolean") {
				meta = {
					hasMore: parsed.hasMore,
					...(parsed.before ? { before: parsed.before } : {}),
				};
			}
			if (parsed.type === "historyDone") break;
			if (seen.length > 200) throw new Error("historyDone never arrived");
		}
		expect(seen).toContain("historyMeta");
		expect(seen.indexOf("historyMeta")).toBeLessThan(seen.indexOf("historyDone"));
		// Six messages behind the newest 40: the page names its oldest.
		expect(meta).toMatchObject({ hasMore: true, before: "msg_u_4" });
		// The newest 40 of 46: the first prompt stays above the fold.
		expect(seen.filter((type) => type === "user")).toHaveLength(20);

		controller.abort();
		await reader.cancel().catch(() => {});
	});

	it("emits no paging facts for a machine that answered the whole snapshot", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const sessionId = await createSession(machine, deviceId);
		machine.onOp("session.sync", () => ({
			epoch: machine.model.epoch,
			seq: 0,
			snapshot: { messages: [], permissions: [], status: "idle", usage: null, todos: [] },
		}));

		const controller = new AbortController();
		const res = await testRequest(streamGET, {
			path: `/api/v2/code/agents/${sessionId}/stream?device=${deviceId}`,
			params: { id: sessionId },
			locals: user.locals,
			signal: controller.signal,
		});
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		expect(reader).toBeTruthy();
		if (!reader) return;

		const seen: string[] = [];
		for (;;) {
			const frame = await readOneFrame(reader);
			const type = (JSON.parse(frame.data) as { type: string }).type;
			seen.push(type);
			if (type === "historyDone") break;
			if (seen.length > 20) throw new Error("historyDone never arrived");
		}
		expect(seen).not.toContain("historyMeta");

		controller.abort();
		await reader.cancel().catch(() => {});
	});
});
