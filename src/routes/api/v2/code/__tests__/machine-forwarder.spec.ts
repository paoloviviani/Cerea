/**
 * The forwarder and the SSE bridge, driven end to end against a fake
 * machine (`tests/fake-machine.ts`) over a real WebSocket — the same
 * `acceptMachineConnection` the production upgrade path calls, just fed by
 * a hand-rolled `http`/`ws` server instead of `server.js`'s. Bearer
 * validation has its own dedicated spec (`machineAuth.spec.ts`); this one
 * starts from an already-authenticated principal so it can focus on the
 * registry, the forwarder's op mapping and the bridge's cursor.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import superjson from "superjson";
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { ready } from "$lib/server/database";
import { createTestUser, cleanupTestData, type TestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
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

afterEach(async () => {
	await cleanupTestData();
});

async function parse<T>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

/** `testRequest` stubs SvelteKit's own routing (its module doc: "only
 * path-to-handler routing is stubbed"), so a `[...path]` catch-all handler
 * needs its rest param supplied by hand — this derives it from the URL so
 * every forwarder call in this file gets it right by construction. */
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
		headers: opts.json === false ? undefined : { "content-type": "application/json" },
		locals: opts.locals,
		signal: opts.signal,
		params: { path: restPath },
	});
}

/** Connect a fake machine, let it reach `pending`, confirm it through the
 * real endpoint (the same click the Agents panel's Confirm button makes),
 * and wait for the `status: paired` push. */
async function connectAndPair(): Promise<FakeMachine> {
	const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
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

describe("the forwarder over a live machine link", () => {
	it("creates a workspace and a session, and lists them back", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;

		const wsRes = await forwarder(forwarderPOST, `/api/v2/code/v1/workspaces?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ path: "/repo", title: "repo" }),
			locals: user.locals,
		});
		expect(wsRes.status).toBe(200);
		const { workspace } = await parse<{ workspace: { id: string; name: string } }>(wsRes);
		expect(workspace.name).toBe("repo");
		expect(machine.model.workspaces).toHaveLength(1);

		const agentRes = await forwarder(forwarderPOST, `/api/v2/code/v1/agents?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ workspaceId: workspace.id, provider: "opencode", posture: "plan" }),
			locals: user.locals,
		});
		expect(agentRes.status).toBe(200);
		const { agent } = await parse<{ agent: { id: string; modeId: string | null } }>(agentRes);
		expect(agent.modeId).toBe("plan");

		const listRes = await forwarder(forwarderGET, `/api/v2/code/v1/agents?device=${deviceId}`, {
			locals: user.locals,
		});
		const { agents } = await parse<{ agents: Array<{ id: string }> }>(listRes);
		expect(agents.map((a) => a.id)).toContain(agent.id);

		machine.close();
	});

	it("mints a clientMessageId server-side when the browser sends none", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const promptArgs: Array<{ clientMessageId?: string }> = [];
		machine.onOp("session.prompt", (args: { clientMessageId?: string }) => {
			promptArgs.push(args);
			return {};
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/messages?device=${deviceId}`,
			{ method: "POST", body: JSON.stringify({ text: "hello" }), locals: user.locals }
		);
		expect(res.status).toBe(200);
		expect(promptArgs).toHaveLength(1);
		expect(promptArgs[0].clientMessageId).toEqual(expect.any(String));
		expect(promptArgs[0].clientMessageId).not.toBe("");

		machine.close();
	});

	it("passes through an explicit messageId instead of minting one", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const promptArgs: Array<{ clientMessageId?: string }> = [];
		machine.onOp("session.prompt", (args: { clientMessageId?: string }) => {
			promptArgs.push(args);
			return {};
		});

		await forwarder(forwarderPOST, `/api/v2/code/v1/agents/${agent.id}/messages?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ text: "hello", messageId: "browser-mid-1" }),
			locals: user.locals,
		});
		expect(promptArgs[0].clientMessageId).toBe("browser-mid-1");

		machine.close();
	});

	it("rejects a non-JSON POST body before it ever reaches the machine (C5)", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const res = await forwarder(forwarderPOST, `/api/v2/code/v1/workspaces?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ path: "/repo" }),
			json: false,
			locals: user.locals,
		});
		expect(res.status).toBe(400);
		expect(machine.model.workspaces).toHaveLength(0);
		machine.close();
	});

	it("answers instantly, never a hang, once the machine goes offline (R1)", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		machine.close();
		// One tick for the server's own `close` handler to evict the registry
		// entry — no arbitrary polling loop, just the microtask/close event.
		await new Promise<void>((resolve) => setTimeout(resolve, 100));

		const start = Date.now();
		const res = await forwarder(forwarderGET, `/api/v2/code/v1/agents?device=${deviceId}`, {
			locals: user.locals,
		});
		expect(res.status).toBe(502);
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("refuses a device that belongs to a different user", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const otherUser = await createTestUser();

		const res = await forwarder(forwarderGET, `/api/v2/code/v1/agents?device=${deviceId}`, {
			locals: otherUser.locals,
		});
		expect(res.status).toBe(404);
		machine.close();
	});
});

describe("the SSE bridge over a live machine link", () => {
	it("emits a session.sync's snapshot on connect, and a live event on the tail", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

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

		// The empty snapshot's own turn state ("idle" status -> done) arrives
		// first, with no live activity needed.
		const first = await readOneFrame(reader);
		expect(first.event).toBe("update");

		// A live permission event, pushed after the snapshot — the tail.
		machine.pushEvent(agent.id, {
			kind: "permission.asked",
			request: {
				id: "perm-1",
				sessionId: agent.id,
				tool: "bash",
				title: "run rm -rf build/",
				patterns: [],
				metadata: {},
				always: [],
			},
		});
		const second = await readOneFrame(reader);
		expect(JSON.parse(second.data).type).toBe("elicitation");

		controller.abort();
		await reader.cancel().catch(() => {});
		machine.close();
	});
});

async function createWorkspace(
	_machine: FakeMachine,
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
	_machine: FakeMachine,
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

/** Read from the SSE stream until one full `\n\n`-terminated frame (an
 * `event:`/`data:` pair, or a heartbeat comment) is available, and return it
 * parsed. Heartbeats (`: heartbeat`) are skipped. */
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
