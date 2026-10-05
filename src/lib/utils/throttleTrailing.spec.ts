import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttleTrailing } from "./throttleTrailing";

describe("throttleTrailing", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("runs the first call at once and holds one that lands inside the window", () => {
		const fn = vi.fn();
		const t = throttleTrailing(fn, 2000);
		t.call();
		expect(fn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(500);
		t.call(); // the child's final status, just after a poll
		t.call();
		expect(fn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1500);
		expect(fn).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(10_000);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("cancel drops a held call", () => {
		const fn = vi.fn();
		const t = throttleTrailing(fn, 1000);
		t.call();
		t.call();
		t.cancel();
		vi.advanceTimersByTime(5000);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
