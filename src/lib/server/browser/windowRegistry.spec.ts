import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import {
	WINDOW_BUSY_MESSAGE,
	WindowLimitError,
	_resetWindowsForTests,
	handleWindowMessage,
	onWindowClosed,
	registerWindow,
	unregisterWindow,
	windowCall,
	windowCapacityFor,
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

	it("the app's 'another task is using this browser' ends the task instead of being a tool error", async () => {
		const { t, win } = register();
		const p = windowCall(win)("act", {});
		handleWindowMessage(
			win,
			JSON.stringify({
				jsonrpc: "2.0",
				id: lastCall(t).id,
				error: { code: -32000, message: WINDOW_BUSY_MESSAGE },
			})
		);
		await expect(p).rejects.toMatchObject({
			message: "Another task is using this browser.",
			kind: "unavailable",
		});
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

	it("an answer to an id this process never issued is an offence, and five close the window", () => {
		const { t, win } = register();
		for (let i = 0; i < 4; i++)
			expect(handleWindowMessage(win, answer(`x${i}`, { content: [] }))).toBe(false);
		expect(windowFor(user, session, WID)).toBeDefined();
		handleWindowMessage(win, answer("x5", { content: [] }));
		expect(t.closes.at(-1)?.[0]).toBe(4400);
		expect(windowFor(user, session, WID)).toBeUndefined();
	});

	it("a late answer to a call that timed out is allowed, a few times", async () => {
		vi.useFakeTimers();
		try {
			const { win, t } = register();
			const ids: string[] = [];
			for (let i = 0; i < 3; i++) {
				const p = windowCall(win)("snapshot", {});
				p.catch(() => undefined);
				ids.push(lastCall(t).id);
				await vi.advanceTimersByTimeAsync(61_000);
			}
			for (const id of ids)
				expect(handleWindowMessage(win, answer(id, { content: [] }))).toBe(true);
			// the same late id twice is not a second allowance
			expect(handleWindowMessage(win, answer(ids[0], { content: [] }))).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("takes image answers only of the four picture types", async () => {
		const { win, t } = register();
		const call = windowCall(win);
		for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
			const ok = call("screenshot", {});
			handleWindowMessage(
				win,
				answer(lastCall(t).id, { content: [{ type: "image", data: "AAAA", mimeType }] })
			);
			await expect(ok).resolves.toBeDefined();
		}
		const bad = call("screenshot", {});
		bad.catch(() => undefined);
		expect(
			handleWindowMessage(
				win,
				answer(lastCall(t).id, {
					content: [{ type: "image", data: "AAAA", mimeType: "image/svg+xml" }],
				})
			)
		).toBe(false);
	});

	it("closes a window that sends more than 50 messages in 10 seconds", async () => {
		const { win, t } = register();
		const call = windowCall(win);
		const ids: string[] = [];
		for (let i = 0; i < 52; i++) {
			call("snapshot", {}).catch(() => undefined);
			ids.push(lastCall(t).id);
		}
		const results = ids.map((id) => handleWindowMessage(win, answer(id, { content: [] })));
		expect(results.slice(0, 50).every(Boolean)).toBe(true);
		expect(results[50]).toBe(false);
		expect(t.closes.at(-1)?.[0]).toBe(4429);
		expect(windowFor(user, session, WID)).toBeUndefined();
	});

	it("closes a window that sends more than its bytes budget in a minute", () => {
		const { win, t } = register();
		const big = JSON.stringify({ pad: "a".repeat(20 * 1024 * 1024) });
		for (let i = 0; i < 6; i++) handleWindowMessage(win, big);
		expect(t.closes.some((c) => c[0] === 4429)).toBe(true);
		expect(windowFor(user, session, WID)).toBeUndefined();
	});

	it("allows at most four windows per user, but lets a window replace itself", () => {
		const ids = ["a", "b", "c", "d"].map((c) => c.repeat(32));
		for (const id of ids) register(transport(), { windowId: id });
		expect(windowCapacityFor(user, "e".repeat(32))).toBe(false);
		expect(windowCapacityFor(user, ids[0])).toBe(true);
		expect(windowCapacityFor("someone-else", "e".repeat(32))).toBe(true);
		// registering enforces it too: two upgrades that both passed the early check cannot both land
		expect(() => register(transport(), { windowId: "e".repeat(32) })).toThrow(WindowLimitError);
		expect(() => register(transport(), { windowId: ids[1] })).not.toThrow();
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

	it("lapses when the window shows no activity for five minutes, so a stuck task cannot hold it", async () => {
		vi.useFakeTimers();
		try {
			register();
			const leases = windowLeaseStore();
			const stuck = await leases.acquire(WID, owner, "stuck");
			expect(stuck).not.toBeNull();
			await vi.advanceTimersByTimeAsync(4 * 60_000);
			expect(await leases.acquire(WID, owner, "early")).toBeNull();
			await vi.advanceTimersByTimeAsync(2 * 60_000);
			const next = await leases.acquire(WID, owner, "next");
			expect(next).not.toBeNull();
			// the old holder's late release does not free the new holder's lease
			await must(stuck).release();
			expect(await leases.acquire(WID, owner, "third")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
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
