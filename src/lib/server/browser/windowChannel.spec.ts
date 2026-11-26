/**
 * The window browser's socket, end to end over real WebSockets: who may connect (ticket, origin,
 * session), what crosses (only answers; malformed messages close it) and what the registry and
 * the lease do when it goes.
 */
import { createServer, type Server } from "node:http";
import { ObjectId } from "mongodb";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ enabled: true, origin: undefined as string | undefined }));
vi.mock("$lib/server/config", async (orig) => {
	const real = await orig<typeof import("$lib/server/config")>();
	return {
		...real,
		config: new Proxy(real.config, {
			get: (target, key) =>
				key === "PUBLIC_ORIGIN" && gate.origin !== undefined
					? gate.origin
					: Reflect.get(target, key),
		}),
	};
});
vi.mock("./settings", async (orig) => ({
	...(await orig<typeof import("./settings")>()),
	browserEnabled: () => gate.enabled,
}));

import { _setWindowRecheckMsForTests, handleWindowUpgrade } from "./windowChannel";
import { mintWindowTicket } from "./windowTickets";
import {
	_resetWindowsForTests,
	windowCall,
	windowFor,
	windowGrantKey,
	windowLeaseStore,
} from "./windowRegistry";

const must = <T>(value: T | null | undefined): T => {
	if (value === null || value === undefined) throw new Error("expected a value");
	return value;
};

const ORIGIN = "https://vitest.invalid"; // the mocked PUBLIC_ORIGIN
const WID = "k".repeat(32);
let httpServer: Server;
let port: number;
const session = { valid: true, fails: false, script: [] as ("fail" | "ok")[] };
const deps = {
	sessionValid: async () => {
		const step = session.script.shift();
		if (step === "fail") throw new Error("database down");
		if (step === "ok") return true;
		if (session.fails) throw new Error("database down");
		return session.valid;
	},
};
const sockets: WebSocket[] = [];

beforeAll(async () => {
	httpServer = createServer();
	httpServer.on("upgrade", (req, socket, head) => {
		void handleWindowUpgrade(req, socket, head, deps);
	});
	await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
	port = (httpServer.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => httpServer.close(() => r())));
afterEach(() => {
	gate.enabled = true;
	session.valid = true;
	session.fails = false;
	session.script = [];
	_setWindowRecheckMsForTests(60_000);
	for (const s of sockets.splice(0)) {
		s.on("error", () => undefined);
		s.terminate();
	}
	_resetWindowsForTests();
});

const ticket = (over: Partial<Parameters<typeof mintWindowTicket>[0]> = {}) =>
	mintWindowTicket({
		userId: "u1",
		sessionId: "s1",
		windowId: WID,
		key: windowGrantKey("secret", WID),
		...over,
	});

function open(t: string | null, origin: string | null = ORIGIN, inUrl = false) {
	const ws = new WebSocket(
		`ws://127.0.0.1:${port}/api/v2/browser/window${inUrl && t ? `?ticket=${t}` : ""}`,
		t === null || inUrl ? [] : ["cerea-window.v1", `ticket.${t}`],
		{ headers: origin === null ? {} : { origin } }
	);
	sockets.push(ws);
	const messages: string[] = [];
	ws.on("message", (m) => messages.push(m.toString()));
	return { ws, messages };
}
const refused = (ws: WebSocket) =>
	new Promise<number>((resolve, reject) => {
		ws.once("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
		ws.once("open", () => reject(new Error("opened")));
		ws.once("error", () => undefined);
	});
const opened = (ws: WebSocket) =>
	new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("unexpected-response", (_q, res) => reject(new Error(`refused ${res.statusCode}`)));
	});
const closed = (ws: WebSocket) => new Promise<number>((r) => ws.once("close", (code) => r(code)));

describe("the window browser socket", () => {
	it("refuses a connection with no ticket, a wrong ticket or a spent one", async () => {
		expect(await refused(open(null).ws)).toBe(401);
		expect(await refused(open("nope").ws)).toBe(401);
		const t = ticket();
		const first = open(t);
		await opened(first.ws);
		expect(await refused(open(t).ws)).toBe(401); // single use
	});

	it("takes the ticket from the subprotocol only, never from the URL", async () => {
		const t = ticket();
		expect(await refused(open(t, ORIGIN, true).ws)).toBe(401);
		// the ticket was not spent by that
		const good = open(t);
		await opened(good.ws);
		expect(good.ws.protocol).toBe("cerea-window.v1");
	});

	it("allows at most four windows per user; a window reconnecting replaces its own", async () => {
		for (let i = 0; i < 4; i++) {
			const c = open(ticket({ windowId: `${i}`.repeat(32) }));
			await opened(c.ws);
		}
		await vi.waitFor(() => expect(windowFor("u1", "s1", "3".repeat(32))).toBeDefined());
		expect(await refused(open(ticket({ windowId: "9".repeat(32) })).ws)).toBe(429);
		// another user is not affected
		await opened(open(ticket({ userId: "u2", windowId: "8".repeat(32) })).ws);
		// the same id again is a replacement, not a fifth window
		await opened(open(ticket({ windowId: "0".repeat(32) })).ws);
	});

	it("refuses a foreign or missing Origin before the ticket is spent", async () => {
		const t = ticket();
		expect(await refused(open(t, "https://evil.example").ws)).toBe(403);
		expect(await refused(open(t, null).ws)).toBe(403);
		// the ticket was not spent by the refused attempts
		await opened(open(t).ws);
	});

	it("fails closed when PUBLIC_ORIGIN is not set: no Origin can match, whatever it says", async () => {
		gate.origin = "";
		try {
			const t = ticket();
			expect(await refused(open(t, ORIGIN).ws)).toBe(403);
			expect(await refused(open(t, "").ws)).toBe(403);
		} finally {
			gate.origin = undefined;
		}
		// the ticket was not spent, and with the origin back the same ticket opens
		const t2 = ticket();
		await opened(open(t2).ws);
	});

	it("refuses when the session is gone, and when browser use is off", async () => {
		session.valid = false;
		expect(await refused(open(ticket()).ws)).toBe(403);
		session.valid = true;
		gate.enabled = false;
		expect(await refused(open(ticket()).ws)).toBe(404);
	});

	it("registers the window with the key its ticket carried, sends no secret, and relays a call and its answer", async () => {
		const c = open(ticket());
		await opened(c.ws);
		await vi.waitFor(() => expect(windowFor("u1", "s1", WID)).toBeDefined());
		const win = must(windowFor("u1", "s1", WID));
		expect(win.key).toEqual(windowGrantKey("secret", WID));
		expect(c.messages).toEqual([]);
		const p = windowCall(win)("tabs", {});
		await vi.waitFor(() => expect(c.messages).toHaveLength(1));
		expect(c.messages[0]).not.toContain(win.key.toString("base64url"));
		const req = JSON.parse(c.messages[0]);
		expect(req.params).toEqual({ name: "tabs", arguments: {} });
		c.ws.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: req.id,
				result: { content: [{ type: "text", text: "[]" }] },
			})
		);
		await expect(p).resolves.toMatchObject({ text: "[]" });
		// another user's session never sees it
		expect(windowFor("u2", "s1", WID)).toBeUndefined();
		expect(windowFor("u1", "s2", WID)).toBeUndefined();
	});

	it("closes on malformed messages and on binary frames, and the window is gone", async () => {
		const c = open(ticket());
		await opened(c.ws);
		await vi.waitFor(() => expect(windowFor("u1", "s1", WID)).toBeDefined());
		const done = closed(c.ws);
		for (let i = 0; i < 5; i++) c.ws.send("{broken");
		expect(await done).toBe(4400);
		await vi.waitFor(() => expect(windowFor("u1", "s1", WID)).toBeUndefined());

		const b = open(ticket());
		await opened(b.ws);
		const doneBinary = closed(b.ws);
		b.ws.send(Buffer.from([1, 2, 3]));
		expect(await doneBinary).toBe(4400);
	});

	it("ends the task and releases the lease when the socket drops", async () => {
		const c = open(ticket());
		await opened(c.ws);
		await vi.waitFor(() => expect(windowFor("u1", "s1", WID)).toBeDefined());
		const win = must(windowFor("u1", "s1", WID));
		const owner = { toString: () => "u1" } as unknown as ObjectId;
		const lease = await windowLeaseStore().acquire(WID, owner, "task");
		expect(lease).not.toBeNull();
		const p = windowCall(win)("snapshot", {});
		p.catch(() => undefined);
		c.ws.close();
		await expect(p).rejects.toThrow(/browser in this app is gone/);
		await vi.waitFor(() => expect(windowFor("u1", "s1", WID)).toBeUndefined());
		await must(lease).release();
		// a window reconnecting under the same id starts with a free lease
		const again = open(ticket());
		await opened(again.ws);
		await vi.waitFor(() => expect(windowFor("u1", "s1", WID)).toBeDefined());
		expect(await windowLeaseStore().acquire(WID, owner, "next")).not.toBeNull();
	});

	it("closes 4403 when the session ends while the socket is open", async () => {
		_setWindowRecheckMsForTests(50);
		const c = open(ticket());
		await opened(c.ws);
		// the re-check interval is read when the socket is accepted: connect another with it set
		const d = open(ticket({ windowId: "z".repeat(32) }));
		await opened(d.ws);
		const done = closed(d.ws);
		session.valid = false;
		expect(await done).toBe(4403);
	});

	it("closes 4403 after three failed session re-checks in a row, and forgives a single blip", async () => {
		_setWindowRecheckMsForTests(30);
		const c = open(ticket({ windowId: "y".repeat(32) }));
		await opened(c.ws);
		const done = closed(c.ws);
		session.fails = true;
		expect(await done).toBe(4403);
		session.fails = false;
		// failed checks that are never three in a row do not close it, however many there are
		const e = open(ticket({ windowId: "x".repeat(32) }));
		await opened(e.ws);
		session.script = ["fail", "fail", "ok", "fail", "fail", "ok", "fail", "fail", "ok", "ok"];
		await vi.waitFor(() => expect(session.script).toHaveLength(0), { timeout: 3000 });
		await new Promise((r) => setTimeout(r, 40));
		expect(e.ws.readyState).toBe(WebSocket.OPEN);
	});
});
