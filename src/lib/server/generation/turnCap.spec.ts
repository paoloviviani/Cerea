import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({ config: {} as Record<string, string | undefined> }));
vi.mock("$lib/server/config", () => cfg);

import {
	armTurnCap,
	classifyTurnAbort,
	TurnTimeoutError,
	turnMaxMinutes,
	untilCapped,
} from "./turnCap";

describe("turn cap", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("a timeout abort is an error with the message; a user abort is interrupted", () => {
		const capped = new AbortController();
		capped.abort(new TurnTimeoutError(30));
		expect(classifyTurnAbort(capped.signal)).toEqual({
			kind: "timeout",
			message: "This answer took longer than 30 minutes and was stopped.",
		});
		const stopped = new AbortController();
		stopped.abort();
		expect(classifyTurnAbort(stopped.signal)).toEqual({ kind: "user" });
	});

	it("aborts the turn once the cap passes, and not when cleared", () => {
		const ctrl = new AbortController();
		armTurnCap(ctrl, 2);
		vi.advanceTimersByTime(119_000);
		expect(ctrl.signal.aborted).toBe(false);
		vi.advanceTimersByTime(2_000);
		expect(ctrl.signal.reason).toBeInstanceOf(TurnTimeoutError);

		const done = new AbortController();
		clearTimeout(armTurnCap(done, 1));
		vi.advanceTimersByTime(10 * 60_000);
		expect(done.signal.aborted).toBe(false);
	});

	it("reads CHAT_TURN_MAX_MINUTES with a default and a floor", () => {
		cfg.config.CHAT_TURN_MAX_MINUTES = undefined;
		expect(turnMaxMinutes()).toBe(30);
		cfg.config.CHAT_TURN_MAX_MINUTES = "";
		expect(turnMaxMinutes()).toBe(30);
		cfg.config.CHAT_TURN_MAX_MINUTES = "abc";
		expect(turnMaxMinutes()).toBe(30);
		cfg.config.CHAT_TURN_MAX_MINUTES = "0";
		expect(turnMaxMinutes()).toBe(30);
		cfg.config.CHAT_TURN_MAX_MINUTES = "45";
		expect(turnMaxMinutes()).toBe(45);
	});
});

describe("untilCapped", () => {
	async function* hangsAfterOne() {
		yield 1;
		await new Promise(() => {}); // a wait that ignores the signal
	}

	it("cuts a turn stuck on a wait that ignores the signal, after the grace", async () => {
		const ctrl = new AbortController();
		const seen: number[] = [];
		const run = (async () => {
			for await (const v of untilCapped(hangsAfterOne(), ctrl.signal, 20)) seen.push(v);
		})();
		await new Promise((r) => setTimeout(r, 5));
		ctrl.abort(new TurnTimeoutError(30));
		await expect(run).rejects.toBeInstanceOf(TurnTimeoutError);
		expect(seen).toEqual([1]);
	});

	it("leaves a Stop to end the turn on its own", async () => {
		const ctrl = new AbortController();
		const run = (async () => {
			for await (const _ of untilCapped(hangsAfterOne(), ctrl.signal, 20)) void _;
		})();
		let settled = false;
		run.then(
			() => (settled = true),
			() => (settled = true)
		);
		ctrl.abort();
		await new Promise((r) => setTimeout(r, 60));
		expect(settled).toBe(false);
	});

	it("passes every value through when nothing aborts", async () => {
		async function* three() {
			yield 1;
			yield 2;
			yield 3;
		}
		const out: number[] = [];
		for await (const v of untilCapped(three(), new AbortController().signal)) out.push(v);
		expect(out).toEqual([1, 2, 3]);
	});
});
