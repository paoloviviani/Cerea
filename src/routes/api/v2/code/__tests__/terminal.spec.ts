/**
 * The terminal's browser-facing surface (ADR 0090, PROTOCOL.md §9),
 * end to end against a fake machine over real WebSockets — the same
 * pattern `machine-forwarder.spec.ts` uses for the machine link, extended
 * with the browser-facing terminal socket (`terminalServer.ts`) on a
 * second upgrade path of the same test HTTP server, exactly as
 * `machineServer.ts`'s single dispatcher routes both in production.
 *
 * Covers: ticket single use/expiry/wrong-user, a revoked device, a foreign
 * Origin refused before the upgrade, step-up (auth_time), the switch and
 * veto's exact 403 text, binary relay with credits and ack pass-through,
 * resume after a simulated machine reconnect, socket close on logout, and
 * that codeAudit/logs never carry content or keystrokes.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import superjson from "superjson";
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import {
	createTestUser,
	cleanupTestData,
	type TestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { acceptMachineConnection } from "$lib/server/code/machines";
import {
	handleTerminalUpgrade,
	_setRecheckIntervalMsForTests,
} from "$lib/server/code/terminalServer";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import {
	decodeBinaryFrame,
	encodeBinaryFrame,
	BIN_TERM_INPUT,
	BIN_TERM_ACK,
	MACHINE_PATH,
} from "$lib/types/machineProtocol";
import { FakeMachine, type FakeMachineOptions } from "../../../../../../tests/fake-machine";
import { GET as forwarderGET, POST as forwarderPOST } from "../[...path]/+server";
import { PATCH as devicesPATCH } from "../devices/+server";

const terminalGate = vi.hoisted(() => ({ enabled: true }));
vi.mock("$lib/server/codeEnabled", () => ({
	codeAgentsEnabled: () => true,
	codeFilesEnabled: () => true,
	codeTerminalEnabled: () => terminalGate.enabled,
}));

const VALID_ORIGIN = "https://vitest.invalid"; // matches the mocked PUBLIC_ORIGIN (vitest-setup-server.ts)

let httpServer: Server;
let machineWss: WebSocketServer;
let port: number;
let principal: MachinePrincipal;
let user: TestUser;

beforeAll(async () => {
	await ready;
	machineWss = new WebSocketServer({ noServer: true });
	httpServer = createServer();
	httpServer.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://internal");
		if (url.pathname === "/api/v2/code/terminal") {
			void handleTerminalUpgrade(req, socket, head);
			return;
		}
		if (url.pathname === MACHINE_PATH) {
			machineWss.handleUpgrade(req, socket, head, (ws) => {
				acceptMachineConnection(ws, req, principal, "test-token");
			});
			return;
		}
		socket.destroy();
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const address = httpServer.address();
	port = typeof address === "object" && address ? address.port : 0;
}, 30_000);

afterAll(async () => {
	machineWss.close();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

let openMachines: FakeMachine[] = [];
let openSockets: WebSocket[] = [];

beforeEach(async () => {
	terminalGate.enabled = true;
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
	// Unconditional, not just in the tests that shrink it: an assertion
	// throwing mid-test must never leave a later test running against a
	// 200ms recheck interval instead of the real 60s.
	_setRecheckIntervalMsForTests(60_000);
	for (const machine of openMachines) machine.close();
	openMachines = [];
	for (const ws of openSockets) {
		// A deliberately-refused connection (a bad Origin, an expired
		// ticket…) never reaches OPEN, and every such test leaves one here
		// for this loop to reap. `ws.terminate()` on a CONNECTING socket
		// doesn't throw synchronously — it emits `"error"` (ws's own
		// `abortHandshake`), and Node throws *that* as an uncaught exception
		// when nothing is listening. The test's own one-shot `once("error",
		// reject)` has already fired and detached by the time cleanup runs,
		// so a throwaway listener here is what actually silences it.
		ws.on("error", () => {
			/* discarding this socket on purpose; nothing awaits its outcome */
		});
		if (ws.readyState === ws.CONNECTING) {
			ws.terminate();
		} else if (ws.readyState === ws.OPEN) {
			ws.close();
		}
	}
	openSockets = [];
	await cleanupTestData();
});

async function parse<T>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

async function forwarder(
	handler: typeof forwarderGET,
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

const TERMINAL_ALLOWED_POLICY = {
	workspaceRoots: [],
	allowFreeModels: false,
	terminal: "allowed" as const,
};

async function connectAndPair(options: FakeMachineOptions = {}): Promise<FakeMachine> {
	const machine = new FakeMachine(`ws://127.0.0.1:${port}${MACHINE_PATH}`, {}, options);
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

/** A machine enrolled with `--allow-terminal`, paired, with one workspace
 * and one open terminal — the common setup every test below builds on. */
async function terminalMachine(): Promise<{
	machine: FakeMachine;
	deviceId: string;
	workspaceId: string;
	terminalId: string;
}> {
	const machine = await connectAndPair({
		machine: { capabilities: { terminal: true } },
		policy: TERMINAL_ALLOWED_POLICY,
	});
	const deviceId = machine.deviceId as string;
	const wsRes = await forwarder(forwarderPOST, `/api/v2/code/v1/workspaces?device=${deviceId}`, {
		method: "POST",
		body: JSON.stringify({ path: "/repo", title: "repo" }),
		locals: user.locals,
	});
	const { workspace } = await parse<{ workspace: { id: string } }>(wsRes);
	const openRes = await forwarder(
		forwarderPOST,
		`/api/v2/code/v1/workspaces/${workspace.id}/terminals?device=${deviceId}`,
		{ method: "POST", body: JSON.stringify({ cols: 80, rows: 24 }), locals: user.locals }
	);
	expect(openRes.status).toBe(200);
	const { terminal } = await parse<{ terminal: { id: string } }>(openRes);
	return { machine, deviceId, workspaceId: workspace.id, terminalId: terminal.id };
}

async function mintTicket(deviceId: string, terminalId: string): Promise<string> {
	// Step-up: a fresh auth_time, so ticket minting itself isn't what these
	// tests are about (that's covered by its own describe block below).
	await collections.sessions.updateOne(
		{ sessionId: user.session.sessionId },
		{ $set: { authTime: new Date() } }
	);
	const res = await forwarder(
		forwarderPOST,
		`/api/v2/code/v1/terminals/${terminalId}/ticket?device=${deviceId}`,
		{ method: "POST", body: "{}", locals: user.locals }
	);
	expect(res.status).toBe(200);
	const { ticket } = await parse<{ ticket: string }>(res);
	return ticket;
}

interface QueuedMessage {
	text?: string;
	binary?: Buffer;
}

/**
 * `nextMessage` used to be a bare `ws.once("message", …)` per call — which
 * loses data the instant more than one frame arrives in the same tick.
 * `flushViewer` (fake-machine.ts) can synchronously `ws.send()` a whole
 * burst of ≤32 KiB output frames in one call (draining a big credit
 * window in one go), and Node's `ws` parses and emits every complete frame
 * already sitting in the socket's read buffer as separate, *synchronous*
 * `"message"` events before yielding back to the event loop. A `.once()`
 * listener fires on the first of those and detaches immediately — so
 * frames 2..N of that same burst have no listener at the moment they're
 * emitted and are gone for good, long before the next `await nextMessage()`
 * gets around to registering a fresh one. A persistent listener with its
 * own FIFO queue (installed once, in `connectTerminalSocket`) is the fix:
 * every message is captured the instant it arrives, in order, regardless
 * of how many land in the same tick.
 */
const messageQueues = new WeakMap<
	WebSocket,
	{ queue: QueuedMessage[]; waiters: Array<(m: QueuedMessage) => void> }
>();

function connectTerminalSocket(ticket: string, origin: string, from?: number): WebSocket {
	const query = new URLSearchParams({
		ticket,
		...(from !== undefined ? { from: String(from) } : {}),
	});
	const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v2/code/terminal?${query}`, {
		headers: { origin },
	});
	openSockets.push(ws);
	const state: { queue: QueuedMessage[]; waiters: Array<(m: QueuedMessage) => void> } = {
		queue: [],
		waiters: [],
	};
	messageQueues.set(ws, state);
	ws.on("message", (data: Buffer | string, isBinary: boolean) => {
		const msg: QueuedMessage = isBinary ? { binary: data as Buffer } : { text: data.toString() };
		const waiter = state.waiters.shift();
		if (waiter) waiter(msg);
		else state.queue.push(msg);
	});
	return ws;
}

function nextMessage(ws: WebSocket): Promise<QueuedMessage> {
	const state = messageQueues.get(ws);
	if (!state) {
		throw new Error(
			"nextMessage: socket has no installed queue — connect it via connectTerminalSocket"
		);
	}
	const queued = state.queue.shift();
	if (queued) return Promise.resolve(queued);
	return new Promise((resolve, reject) => {
		// 15s, not a tighter value: the first message on a fresh connection
		// waits on a real terminal.attach round trip through the machine
		// link (opDeadlineMs's own default), and a loaded box can genuinely
		// take longer than a couple of seconds for that.
		const timer = setTimeout(() => {
			const idx = state.waiters.indexOf(onMessage);
			if (idx >= 0) state.waiters.splice(idx, 1);
			reject(new Error("timed out waiting for a message"));
		}, 15_000);
		const onMessage = (m: QueuedMessage): void => {
			clearTimeout(timer);
			resolve(m);
		};
		state.waiters.push(onMessage);
	});
}

function waitOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
}

/** The relay's own first attach happens asynchronously right after the
 * upgrade (§9.3 terminal.attach): a brand-new terminal has never had an
 * offset given before, so that first attach is always a reset, and its
 * `{t:"reset",…}` control frame is the signal that `currentChannel` is now
 * set server-side — input sent before it would otherwise be silently
 * dropped (the relay ignores binary frames with no channel yet). */
async function waitForReset(ws: WebSocket): Promise<void> {
	const msg = await nextMessage(ws);
	expect(msg.text).toBeDefined();
	expect(JSON.parse(msg.text as string)).toMatchObject({ t: "reset" });
}

describe("terminal tickets", () => {
	it("mints a ticket only for the caller's own device", async () => {
		const { deviceId, terminalId } = await terminalMachine();
		const other = await createTestUser();
		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/terminals/${terminalId}/ticket?device=${deviceId}`,
			{ method: "POST", body: "{}", locals: other.locals }
		);
		expect(res.status).toBe(404); // getPairedDevice: not this user's device
	});

	it("step-up: a stale or missing auth_time answers 401 with a reauth hint", async () => {
		const { deviceId, terminalId } = await terminalMachine();
		// createTestUser's session carries no authTime at all.
		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/terminals/${terminalId}/ticket?device=${deviceId}`,
			{ method: "POST", body: "{}", locals: user.locals }
		);
		expect(res.status).toBe(401);
		const body = await parse<{ code?: string }>(res);
		expect(body.code).toBe("reauth_required");

		await collections.sessions.updateOne(
			{ sessionId: user.session.sessionId },
			{ $set: { authTime: new Date(Date.now() - 8 * 24 * 3600 * 1000) } } // 8d ago: stale
		);
		const stale = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/terminals/${terminalId}/ticket?device=${deviceId}`,
			{ method: "POST", body: "{}", locals: user.locals }
		);
		expect(stale.status).toBe(401);

		await collections.sessions.updateOne(
			{ sessionId: user.session.sessionId },
			{ $set: { authTime: new Date(Date.now() - 1 * 3600 * 1000) } } // 1h ago: fresh
		);
		const fresh = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/terminals/${terminalId}/ticket?device=${deviceId}`,
			{ method: "POST", body: "{}", locals: user.locals }
		);
		expect(fresh.status).toBe(200);
	});

	it("the switch off answers 404; the machine veto answers 403 with the exact fix", async () => {
		const { machine, deviceId, workspaceId } = await terminalMachine();

		terminalGate.enabled = false;
		const offRes = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/workspaces/${workspaceId}/terminals?device=${deviceId}`,
			{ locals: user.locals }
		);
		expect(offRes.status).toBe(404);
		terminalGate.enabled = true;

		// A second machine, enrolled with the terminal denied. A fresh
		// machineId: connectAndPair's `hello()` looks the device row up by
		// {userId, machineId}, and the shared `principal` still carries the
		// first machine's id — reusing it here would "reconnect" as the same
		// already-paired device instead of pairing a new one.
		principal = { ...principal, machineId: randomUUID() };
		const denied = await connectAndPair({
			machine: { capabilities: { terminal: true } },
			policy: {
				workspaceRoots: [],
				allowFreeModels: false,
				terminal: "denied",
			},
		});
		const deniedDeviceId = denied.deviceId as string;
		const vetoRes = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/workspaces/${workspaceId}/terminals?device=${deniedDeviceId}`,
			{ locals: user.locals }
		);
		expect(vetoRes.status).toBe(403);
		expect(await vetoRes.text()).toContain(
			"This machine was enrolled with terminals off. Re-enroll it (terminals are on by default) to use them here."
		);
		const audited = await collections.codeAudit.findOne({
			deviceId: new ObjectId(deniedDeviceId),
			action: "terminal.refused",
		});
		expect(audited).not.toBeNull();

		machine.close();
	});
});

describe("the terminal WebSocket", () => {
	it("refuses a foreign Origin before the upgrade completes", async () => {
		const { deviceId, terminalId } = await terminalMachine();
		const ticket = await mintTicket(deviceId, terminalId);
		const ws = connectTerminalSocket(ticket, "https://evil.invalid");
		const rejection = await new Promise<{ statusCode?: number }>((resolve) => {
			ws.once("unexpected-response", (_req, res) => resolve({ statusCode: res.statusCode }));
			ws.once("open", () => resolve({ statusCode: 101 }));
		});
		expect(rejection.statusCode).toBe(403);
	});

	it("refuses a missing or expired ticket", async () => {
		const ws = connectTerminalSocket("not-a-real-ticket", VALID_ORIGIN);
		const rejection = await new Promise<{ statusCode?: number }>((resolve) => {
			ws.once("unexpected-response", (_req, res) => resolve({ statusCode: res.statusCode }));
			ws.once("open", () => resolve({ statusCode: 101 }));
		});
		expect(rejection.statusCode).toBe(401);
	});

	it("is single-use: a second redemption of the same ticket is refused", async () => {
		const { deviceId, terminalId } = await terminalMachine();
		const ticket = await mintTicket(deviceId, terminalId);
		const first = connectTerminalSocket(ticket, VALID_ORIGIN);
		await waitOpen(first);
		first.close();

		const second = connectTerminalSocket(ticket, VALID_ORIGIN);
		const rejection = await new Promise<{ statusCode?: number }>((resolve) => {
			second.once("unexpected-response", (_req, res) => resolve({ statusCode: res.statusCode }));
			second.once("open", () => resolve({ statusCode: 101 }));
		});
		expect(rejection.statusCode).toBe(401);
	});

	it("closes with 1009 on an oversized frame, which never reaches the machine", async () => {
		const { machine, deviceId, terminalId } = await terminalMachine();
		const ticket = await mintTicket(deviceId, terminalId);
		const ws = connectTerminalSocket(ticket, VALID_ORIGIN);
		ws.binaryType = "nodebuffer";
		await waitOpen(ws);
		await waitForReset(ws);

		// Well past MAX_WS_PAYLOAD (64 KiB): the ws-level maxPayload check
		// must reject this before the application-level MAX_INPUT_FRAME_PAYLOAD
		// check (or any machine op) ever sees it.
		const oversized = encodeBinaryFrame({
			kind: BIN_TERM_INPUT,
			channel: "x",
			offset: 0,
			payload: Buffer.alloc(100 * 1024, 0x42),
		});
		const closeCode = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("socket never closed")), 5000);
			ws.once("close", (code: number) => {
				clearTimeout(timer);
				resolve(code);
			});
			ws.send(oversized);
		});
		expect(closeCode).toBe(1009);
		expect(machine.model.terminals.get(terminalId)?.history.length ?? 0).toBe(0);
	});

	it("refuses a ticket for a device that was revoked in the meantime", async () => {
		const { deviceId, terminalId } = await terminalMachine();
		const ticket = await mintTicket(deviceId, terminalId);
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(deviceId) },
			{ $set: { status: "revoked" } }
		);
		const ws = connectTerminalSocket(ticket, VALID_ORIGIN);
		const rejection = await new Promise<{ statusCode?: number }>((resolve) => {
			ws.once("unexpected-response", (_req, res) => resolve({ statusCode: res.statusCode }));
			ws.once("open", () => resolve({ statusCode: 101 }));
		});
		expect(rejection.statusCode).toBe(403);
	});

	it("refuses a ticket for a session that expired in the meantime", async () => {
		const { deviceId, terminalId } = await terminalMachine();
		const ticket = await mintTicket(deviceId, terminalId);
		// The session document may still physically exist (the TTL sweep is
		// lazy, database.ts's `expireAfterSeconds: 0` index runs on its own
		// cadence) — expiry must be checked at read time, not inferred from
		// the document's mere presence.
		await collections.sessions.updateOne(
			{ sessionId: user.session.sessionId },
			{ $set: { expiresAt: new Date(Date.now() - 1000) } }
		);
		const ws = connectTerminalSocket(ticket, VALID_ORIGIN);
		const rejection = await new Promise<{ statusCode?: number }>((resolve) => {
			ws.once("unexpected-response", (_req, res) => resolve({ statusCode: res.statusCode }));
			ws.once("open", () => resolve({ statusCode: 101 }));
		});
		expect(rejection.statusCode).toBe(403);
	});

	it("closes an open socket with 4403 once its session expires, at the recheck", async () => {
		// A real 60s is too slow for a unit test to wait out; shrink the
		// interval for this test only (the global afterEach always resets it,
		// even if an assertion below throws), so the *actual* timer fires
		// rather than asserting on `checkAuthorized` directly (which the
		// earlier upgrade-time tests already do) — this one is the timer's
		// own wiring.
		_setRecheckIntervalMsForTests(200);
		const { machine, deviceId, terminalId } = await terminalMachine();
		const ticket = await mintTicket(deviceId, terminalId);
		const ws = connectTerminalSocket(ticket, VALID_ORIGIN);
		ws.binaryType = "nodebuffer";
		await waitOpen(ws);
		await waitForReset(ws);

		await collections.sessions.updateOne(
			{ sessionId: user.session.sessionId },
			{ $set: { expiresAt: new Date(Date.now() - 1000) } }
		);

		const closeCode = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("recheck never closed the socket")), 5000);
			ws.once("close", (code: number) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
		expect(closeCode).toBe(4403);
		machine.close();
	});

	it("closes an open socket with 4403 reauth_required once its sign-in passes 7 days, at the recheck", async () => {
		// A terminal opened just before the window lapses must not live as long
		// as its socket: an upgrade never passes the hook's /code guard, so the
		// socket's own 60s re-check carries freshness too.
		_setRecheckIntervalMsForTests(200);
		const { machine, deviceId, terminalId } = await terminalMachine();
		const ticket = await mintTicket(deviceId, terminalId);
		const ws = connectTerminalSocket(ticket, VALID_ORIGIN);
		ws.binaryType = "nodebuffer";
		await waitOpen(ws);
		await waitForReset(ws);

		await collections.sessions.updateOne(
			{ sessionId: user.session.sessionId },
			{ $set: { authTime: new Date(Date.now() - 8 * 24 * 3600 * 1000) } }
		);

		const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("recheck never closed the socket")), 5000);
			ws.once("close", (code: number, reason: Buffer) => {
				clearTimeout(timer);
				resolve({ code, reason: reason.toString() });
			});
		});
		expect(closed).toEqual({ code: 4403, reason: "reauth_required" });
		machine.close();
	});

	it("keeps a socket whose sign-in is still fresh at the recheck", async () => {
		_setRecheckIntervalMsForTests(100);
		const { machine, deviceId, terminalId } = await terminalMachine();
		const ticket = await mintTicket(deviceId, terminalId);
		const ws = connectTerminalSocket(ticket, VALID_ORIGIN);
		ws.binaryType = "nodebuffer";
		await waitOpen(ws);
		await waitForReset(ws);
		let closed = false;
		ws.once("close", () => (closed = true));
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(closed).toBe(false);
		ws.close();
		machine.close();
	});

	it("relays keystrokes and output, honours credits, and closes on logout", async () => {
		_setRecheckIntervalMsForTests(200);
		const { machine, deviceId, terminalId } = await terminalMachine();
		const secret = "SECRET_KEYSTROKES_should_never_be_logged";
		const warnSpy = vi.spyOn(logger, "warn");
		const infoSpy = vi.spyOn(logger, "info");

		const ticket = await mintTicket(deviceId, terminalId);
		const ws = connectTerminalSocket(ticket, VALID_ORIGIN);
		ws.binaryType = "nodebuffer";
		await waitOpen(ws);
		await waitForReset(ws);

		// The fake machine echoes input by default: type the secret, see it come back.
		ws.send(
			encodeBinaryFrame({
				kind: BIN_TERM_INPUT,
				channel: "x",
				offset: 0,
				payload: Buffer.from(secret),
			})
		);
		const echoed = await nextMessage(ws);
		expect(echoed.binary).toBeDefined();
		const decoded = decodeBinaryFrame(echoed.binary as Buffer);
		expect(decoded?.payload.toString()).toBe(secret);

		// Ack it back, exercising the ack relay (browser -> Cerea -> machine).
		const ackOffset = (decoded?.offset ?? 0) + secret.length;
		ws.send(
			encodeBinaryFrame({
				kind: BIN_TERM_ACK,
				channel: "x",
				offset: ackOffset,
				payload: Buffer.alloc(0),
			})
		);
		// The ack travels browser -> Cerea -> machine asynchronously (real
		// network hops even on loopback); waiting for the fake's own state to
		// reflect it before pushing more output is what makes the credit math
		// below exact, rather than racing the push against the ack's transit.
		const terminalChannel = [...(machine.model.terminals.get(terminalId)?.viewers.keys() ?? [])][0];
		await vi.waitFor(
			() => {
				expect(machine.model.terminals.get(terminalId)?.viewers.get(terminalChannel)?.acked).toBe(
					ackOffset
				);
			},
			{ timeout: 5000 }
		);

		// Credits: push more than the 256 KiB window in one go; only the
		// window's worth should arrive before an ack unblocks the rest.
		const big = Buffer.alloc(300 * 1024, 0x41);
		machine.pushTerminalOutput(terminalId, big);
		let received = 0;
		let lastOffset = 0;
		while (received < 256 * 1024) {
			const msg = await nextMessage(ws);
			const frame = msg.binary ? decodeBinaryFrame(msg.binary) : null;
			if (!frame) continue;
			received += frame.payload.length;
			lastOffset = frame.offset + frame.payload.length;
		}
		expect(received).toBe(256 * 1024); // acked before the push: exactly one credit window
		// Nothing more arrives without an ack: a short race is a genuine failure
		// (it would mean the credit window did nothing), so this is a real check.
		const stalled = await Promise.race([
			nextMessage(ws).then(() => "message"),
			new Promise((resolve) => setTimeout(() => resolve("timeout"), 300)),
		]);
		expect(stalled).toBe("timeout");

		ws.send(
			encodeBinaryFrame({
				kind: BIN_TERM_ACK,
				channel: "x",
				offset: lastOffset,
				payload: Buffer.alloc(0),
			})
		);
		const rest = await nextMessage(ws);
		expect(decodeBinaryFrame(rest.binary as Buffer)?.payload.length).toBeGreaterThan(0);

		// Logout: the session is gone outright (routes/logout/+server.ts
		// deletes the document, unlike expiry). The recheck interval was
		// shrunk above so this closes for real rather than asserting on
		// checkAuthorized directly.
		await collections.sessions.deleteOne({ sessionId: user.session.sessionId });
		const closeCode = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("recheck never closed the socket")), 5000);
			ws.once("close", (code: number) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
		expect(closeCode).toBe(4403);

		// codeAudit and logs never carry the secret.
		const auditRows = await collections.codeAudit
			.find({ deviceId: new ObjectId(deviceId) })
			.toArray();
		expect(auditRows.length).toBeGreaterThan(0);
		for (const row of auditRows) {
			expect(JSON.stringify(row)).not.toContain(secret);
		}
		for (const call of [...warnSpy.mock.calls, ...infoSpy.mock.calls]) {
			expect(JSON.stringify(call)).not.toContain(secret);
		}

		machine.close();
	});

	it("sends reset before the replayed backlog, even when the backlog lands first", async () => {
		const { machine, deviceId, terminalId } = await terminalMachine();
		machine.pushTerminalOutput(terminalId, Buffer.from("backlog-before-reload"));
		machine.flushBacklogBeforeAttachReply = true;

		const ticket = await mintTicket(deviceId, terminalId);
		const ws = connectTerminalSocket(ticket, VALID_ORIGIN);
		ws.binaryType = "nodebuffer";
		await waitOpen(ws);
		// A browser reapplies `reset` by clearing the screen, so a backlog
		// relayed ahead of it would be wiped: reset must come first.
		await waitForReset(ws);
		const replay = await nextMessage(ws);
		expect(decodeBinaryFrame(replay.binary as Buffer)?.payload.toString()).toBe(
			"backlog-before-reload"
		);
	});

	it("resumes from the last relayed offset after a simulated machine reconnect", async () => {
		const { machine, deviceId, terminalId } = await terminalMachine();
		const ticket = await mintTicket(deviceId, terminalId);
		const ws = connectTerminalSocket(ticket, VALID_ORIGIN);
		ws.binaryType = "nodebuffer";
		await waitOpen(ws);
		await waitForReset(ws);

		machine.pushTerminalOutput(terminalId, Buffer.from("before-drop"));
		const first = decodeBinaryFrame((await nextMessage(ws)).binary as Buffer);
		expect(first?.payload.toString()).toBe("before-drop");
		const lastOffset = (first?.offset ?? 0) + (first?.payload.length ?? 0);

		// Simulate the machine link dropping (not the browser socket): the
		// browser tab should learn about it and later resume, never re-mint.
		machine.close();
		const offline = await nextMessage(ws);
		expect(offline.text).toBeDefined();
		expect(JSON.parse(offline.text as string)).toEqual({ t: "machine-offline" });

		// Reconnect with the same machineId, sharing the same in-memory model
		// (the terminal survives a link blip when the galopin process itself
		// does) — onHello finds the existing paired device row.
		const reconnected = new FakeMachine(
			`ws://127.0.0.1:${port}${MACHINE_PATH}`,
			{},
			{ machine: { capabilities: { terminal: true } }, policy: TERMINAL_ALLOWED_POLICY },
			machine.model
		);
		openMachines.push(reconnected);
		const helloResult = await reconnected.hello();
		expect(helloResult.status).toBe("paired");

		const online = await nextMessage(ws);
		expect(JSON.parse(online.text as string)).toEqual({ t: "machine-online" });

		reconnected.pushTerminalOutput(terminalId, Buffer.from("after-reconnect"));
		const resumed = await nextMessage(ws);
		expect(resumed.binary).toBeDefined(); // from is defined and >= ringStart: no reset frame
		const frame = decodeBinaryFrame(resumed.binary as Buffer);
		expect(frame?.offset).toBeGreaterThanOrEqual(lastOffset);
		expect(frame?.payload.toString()).toBe("after-reconnect");

		reconnected.close();
	});
});
