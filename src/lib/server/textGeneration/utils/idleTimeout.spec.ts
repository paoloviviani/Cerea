import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({ config: {} as Record<string, string | undefined> }));
vi.mock("$lib/server/config", () => cfg);

import {
	linkedRequestSignal,
	STREAM_IDLE_MESSAGE,
	StreamIdleError,
	streamIdleTimeoutMs,
	withIdleTimeout,
} from "./idleTimeout";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const v of it) out.push(v);
	return out;
}

describe("withIdleTimeout", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("passes chunks through untouched when they keep coming", async () => {
		const onIdle = vi.fn();
		async function* src() {
			for (const n of [1, 2, 3]) {
				await new Promise((r) => setTimeout(r, 400));
				yield n;
			}
		}
		const p = collect(withIdleTimeout(src(), { timeoutMs: 500, onIdle }));
		await vi.advanceTimersByTimeAsync(2000);
		expect(await p).toEqual([1, 2, 3]);
		expect(onIdle).not.toHaveBeenCalled();
	});

	it("aborts and throws a readable error when the stream yields, then hangs", async () => {
		const own = linkedRequestSignal();
		async function* src() {
			yield "a";
			await new Promise(() => {}); // never sends, never closes
		}
		const seen: string[] = [];
		const p = (async () => {
			for await (const v of withIdleTimeout(src(), { timeoutMs: 500, onIdle: own.abort })) {
				seen.push(v);
			}
		})();
		const assertion = expect(p).rejects.toThrow(STREAM_IDLE_MESSAGE);
		await vi.advanceTimersByTimeAsync(600);
		await assertion;
		expect(seen).toEqual(["a"]);
		expect(own.signal.aborted).toBe(true);
		await expect(p).rejects.toBeInstanceOf(StreamIdleError);
	});

	it("counts the wait before the first chunk", async () => {
		const onIdle = vi.fn();
		const hang: AsyncIterable<number> = {
			[Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
		};
		const p = collect(withIdleTimeout(hang, { timeoutMs: 500, onIdle }));
		const assertion = expect(p).rejects.toBeInstanceOf(StreamIdleError);
		await vi.advanceTimersByTimeAsync(600);
		await assertion;
		expect(onIdle).toHaveBeenCalledTimes(1);
	});
});

describe("linkedRequestSignal", () => {
	it("follows the parent and can also abort on its own", () => {
		const parent = new AbortController();
		const a = linkedRequestSignal(parent.signal);
		parent.abort();
		expect(a.signal.aborted).toBe(true);
		const b = linkedRequestSignal(new AbortController().signal);
		b.abort();
		expect(b.signal.aborted).toBe(true);
	});
});

describe("streamIdleTimeoutMs", () => {
	it("defaults, honours a value, and holds the floor", () => {
		cfg.config.CHAT_STREAM_IDLE_TIMEOUT_MS = undefined;
		expect(streamIdleTimeoutMs()).toBe(300_000);
		cfg.config.CHAT_STREAM_IDLE_TIMEOUT_MS = "";
		expect(streamIdleTimeoutMs()).toBe(300_000);
		cfg.config.CHAT_STREAM_IDLE_TIMEOUT_MS = "junk";
		expect(streamIdleTimeoutMs()).toBe(300_000);
		cfg.config.CHAT_STREAM_IDLE_TIMEOUT_MS = "90000";
		expect(streamIdleTimeoutMs()).toBe(90_000);
		cfg.config.CHAT_STREAM_IDLE_TIMEOUT_MS = "1000";
		expect(streamIdleTimeoutMs()).toBe(30_000);
	});
});
