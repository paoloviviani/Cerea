import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleInterval } from "./visibleInterval";

let hidden = false;
function setHidden(value: boolean) {
	hidden = value;
	document.dispatchEvent(new Event("visibilitychange"));
}

describe("visibleInterval", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		hidden = false;
		Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("ticks while visible", () => {
		const fn = vi.fn();
		const stop = visibleInterval(fn, 1000);
		vi.advanceTimersByTime(3500);
		expect(fn).toHaveBeenCalledTimes(3);
		stop();
	});

	it("does not tick while hidden, and refreshes once on return", () => {
		const fn = vi.fn();
		const stop = visibleInterval(fn, 1000);
		setHidden(true);
		vi.advanceTimersByTime(60_000);
		expect(fn).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		setHidden(false);
		expect(fn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(2000);
		expect(fn).toHaveBeenCalledTimes(3);
		stop();
	});

	it("starts nothing when mounted hidden, and cleans up", () => {
		hidden = true;
		const fn = vi.fn();
		const stop = visibleInterval(fn, 1000);
		vi.advanceTimersByTime(5000);
		expect(fn).not.toHaveBeenCalled();
		stop();
		setHidden(false);
		expect(fn).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
