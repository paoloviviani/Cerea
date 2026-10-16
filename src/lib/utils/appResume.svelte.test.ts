import { describe, it, expect, vi, beforeEach } from "vitest";
import { onAppResume, resetAppResume } from "./appResume";

describe("onAppResume", () => {
	beforeEach(() => {
		resetAppResume();
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
	});

	it("fires when the tab becomes visible, and on online", () => {
		const fn = vi.fn();
		const stop = onAppResume(fn);
		Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
		expect(fn).toHaveBeenCalledTimes(1);
		vi.setSystemTime(110_000);
		window.dispatchEvent(new Event("online"));
		expect(fn).toHaveBeenCalledTimes(2);
		stop();
		vi.useRealTimers();
	});

	it("does not fire when the tab is hidden, and coalesces a burst", () => {
		const fn = vi.fn();
		const stop = onAppResume(fn);
		Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
		expect(fn).not.toHaveBeenCalled();
		Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("online"));
		expect(fn).toHaveBeenCalledTimes(1);
		stop();
		vi.useRealTimers();
	});

	it("stops listening after the last unsubscribe", () => {
		const fn = vi.fn();
		onAppResume(fn)();
		window.dispatchEvent(new Event("online"));
		expect(fn).not.toHaveBeenCalled();
		vi.useRealTimers();
	});
});
