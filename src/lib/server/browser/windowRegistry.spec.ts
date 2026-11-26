import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import {
	_resetWindowsForTests,
	handleWindowMessage,
	onWindowClosed,
	registerWindow,
	unregisterWindow,
	windowCall,
	windowFor,
	windowForTurn,
	windowGrantKey,
	windowLeaseStore,
} from "./windowRegistry";

const must = <T>(value: T | null | undefined): T => {
	if (value === null || value === undefined) throw new Error("expected a value");
	return value;
};

const WID = "w".repeat(32);
const user = "u1";
const session = "s1";

function transport() {
	const sent: string[] = [];
	const closes: Array<[number, string]> = [];
	return {
		sent,
		closes,
		send: (t: string) => void sent.push(t),
		close: (code: number, reason: string) => void closes.push([code, reason]),
	};
}
const register = (t = transport(), over: Partial<Parameters<typeof registerWindow>[0]> = {}) => ({
	t,
	win: registerWindow({
		userId: user,
		sessionId: session,
		windowId: WID,
		key: windowGrantKey("secret", WID),
		transport: t,
		...over,
	}),
});
const lastCall = (t: ReturnType<typeof transport>) => JSON.parse(t.sent.at(-1) as string);
const answer = (id: string, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });

afterEach(() => _resetWindowsForTests());

describe("the window registry", () => {
	it("derives the grant key from the session secret and the window id, as the app does", () => {
		// One shared vector with desktop/test/windowBrowser.test.ts: the two sides must agree.
		expect(windowGrantKey("session-secret-1", WID).toString("base64url")).toBe(
			"wCHTHLSWwMEgM93UlYwsthZyQDhe8mALmKvR11ee_I8"
		);
		expect(
			windowGrantKey("session-secret-2", WID).equals(windowGrantKey("session-secret-1", WID))
		).toBe(false);
		expect(
			windowGrantKey("session-secret-1", "x".repeat(32)).equals(
				windowGrantKey("session-secret-1", WID)
			)
		).toBe(false);
	});

	it("keeps the window's key in memory and sends nothing on connect", () => {
		const { t, win } = register();
		expect(t.sent).toEqual([]);
		expect(win.key).toEqual(windowGrantKey("secret", WID));
	});

	it("finds a window only for its own user, session and id", () => {
		register();
		expect(windowFor(user, session, WID)).toBeDefined();
		expect(windowFor("other", session, WID)).toBeUndefined();
		expect(windowFor(user, "other-session", WID)).toBeUndefined();
		expect(windowFor(user, session, "x".repeat(32))).toBeUndefined();
		expect(windowFor(user, session, undefined)).toBeUndefined();
		expect(windowFor(user, session, "short")).toBeUndefined();
		expect(windowFor(user, session, "../../etc/passwd-----------")).toBeUndefined();
	});

	it("a tools/call goes down and its answer comes back as the runtime call's result", async () => {
		const { t, win } = register();
		const call = windowCall(win);
		const p = call("snapshot", { a: 1 });
		const sent = lastCall(t);
		expect(sent).toMatchObject({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: "snapshot", arguments: { a: 1 } },
		});
		expect(
			handleWindowMessage(
				win,
				answer(sent.id, {
					content: [
						{ type: "text", text: '{"url":"x"}' },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					],
					structuredContent: { url: "x" },
				})
			)
		).toBe(true);
		await expect(p).resolves.toMatchObject({
			text: '{"url":"x"}',
			isError: false,
			structured: { url: "x" },
		});
	});

	it("never sends a tool outside the contract", async () => {
		const { t, win } = register();
		await expect(windowCall(win)("evaluate" as never, {})).rejects.toThrow(/Unknown browser tool/);
		expect(t.sent).toHaveLength(0);
	});

	it("a JSON-RPC error and a tool error are both reported, not mistaken for results", async () => {
		const { t, win } = register();
		const call = windowCall(win);
		const p1 = call("act", {});
		handleWindowMessage(
			win,
			JSON.stringify({
				jsonrpc: "2.0",
				id: lastCall(t).id,
				error: { code: -32000, message: "nope" },
			})
		);
		await expect(p1).rejects.toThrow(/reported an error in act: nope/);
		const p2 = call("act", {});
		handleWindowMessage(
			win,
			answer(lastCall(t).id, { content: [{ type: "text", text: "bad" }], isError: true })
		);
		await expect(p2).resolves.toMatchObject({ isError: true, text: "bad" });
	});

	it("refuses a window's malformed messages, and closes a window that keeps sending them", () => {
		const { t, win } = register();
		const bad = [
			"not json",
			"[]",
			'{"jsonrpc":"2.0","method":"tools/call","id":"a","params":{}}', // a request from the window
			'{"jsonrpc":"2.0","id":"a"}', // neither result nor error
			JSON.stringify({
				jsonrpc: "2.0",
				id: "a",
				result: { content: [] },
				error: { code: 1, message: "m" },
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				id: "a",
				result: { content: [{ type: "video", url: "x" }] },
			}),
			JSON.stringify({ jsonrpc: "2.0", id: 5, result: { content: [] } }),
		];
		const outcomes = bad.map((m) => handleWindowMessage(win, m));
		expect(outcomes.every((o) => o === false)).toBe(true);
		// five offences: closed 4400, and gone
		expect(t.closes.at(-1)?.[0]).toBe(4400);
		expect(windowFor(user, session, WID)).toBeUndefined();
	});

	it("an answer to a call nobody is waiting for is ignored, not an offence", () => {
		const { win } = register();
		for (let i = 0; i < 10; i++)
			expect(handleWindowMessage(win, answer(`late${i}`, { content: [] }))).toBe(true);
		expect(windowFor(user, session, WID)).toBeDefined();
	});

	it("times out a call, and aborts one when the task is stopped", async () => {
		vi.useFakeTimers();
		try {
			const { win } = register();
			const p = windowCall(win)("snapshot", {});
			p.catch(() => undefined);
			await vi.advanceTimersByTimeAsync(61_000);
			await expect(p).rejects.toThrow(/did not answer/);
			const ctl = new AbortController();
			const q = windowCall(win)("snapshot", {}, ctl.signal);
			ctl.abort();
			await expect(q).rejects.toThrow(/Aborted/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("when the link ends, every waiting call fails with a plain reason and closers run", async () => {
		const { win } = register();
		const closed = vi.fn();
		onWindowClosed(win, closed);
		const p = windowCall(win)("snapshot", {});
		unregisterWindow(win, "the window was closed");
		await expect(p).rejects.toThrow(/browser in this app is gone/);
		expect(closed).toHaveBeenCalledTimes(1);
		await expect(windowCall(win)("snapshot", {})).rejects.toThrow(/not connected/);
		expect(windowFor(user, session, WID)).toBeUndefined();
	});

	it("a window that connects again replaces the old link, which is closed", async () => {
		const first = register();
		const p = windowCall(first.win)("snapshot", {});
		p.catch(() => undefined);
		const second = register();
		expect(first.t.closes.at(-1)?.[0]).toBe(4409);
		await expect(p).rejects.toThrow(/gone/);
		expect(windowFor(user, session, WID)).toBe(second.win);
		// the old socket closing afterwards does not drop the new link
		unregisterWindow(first.win);
		expect(windowFor(user, session, WID)).toBe(second.win);
	});
});

describe("the window lease", () => {
	const owner = { toString: () => user } as unknown as ObjectId;
	const stranger = { toString: () => "someone-else" } as unknown as ObjectId;

	it("is one task at a time, and free again after release", async () => {
		register();
		const leases = windowLeaseStore();
		const first = await leases.acquire(WID, owner, "h1");
		expect(first).not.toBeNull();
		expect(await leases.acquire(WID, owner, "h2")).toBeNull();
		await must(first).release();
		const again = await leases.acquire(WID, owner, "h3");
		expect(again).not.toBeNull();
		await must(again).release();
	});

	it("is only for the window's own user, and for a window that is linked", async () => {
		register();
		const leases = windowLeaseStore();
		expect(await leases.acquire(WID, stranger, "h")).toBeNull();
		expect(await leases.acquire("x".repeat(32), owner, "h")).toBeNull();
	});

	it("is released with the window: the next window of that id starts free", async () => {
		const { win } = register();
		const leases = windowLeaseStore();
		await leases.acquire(WID, owner, "h1");
		unregisterWindow(win);
		expect(await leases.acquire(WID, owner, "h2")).toBeNull(); // no link, nothing to lease
		register();
		expect(await leases.acquire(WID, owner, "h3")).not.toBeNull();
	});
});

describe("the window a turn came from", () => {
	const locals = (over: Record<string, unknown> = {}) => ({
		user: { _id: { toString: () => user } },
		sessionId: session,
		browserWindowId: WID,
		...over,
	});
	it("is the user's live window on the same session", () => {
		const { win } = register();
		expect(windowForTurn(locals())).toBe(win);
	});
	it("is none for another user, another session, a scheduled run, no id, or a window that is gone", () => {
		const { win } = register();
		expect(windowForTurn(locals({ user: { _id: { toString: () => "u2" } } }))).toBeUndefined();
		expect(windowForTurn(locals({ sessionId: "other" }))).toBeUndefined();
		expect(windowForTurn(locals({ scheduledRun: { permissionMode: "ask" } }))).toBeUndefined();
		expect(windowForTurn(locals({ browserWindowId: undefined }))).toBeUndefined();
		expect(windowForTurn(undefined)).toBeUndefined();
		unregisterWindow(win);
		expect(windowForTurn(locals())).toBeUndefined();
	});
});
