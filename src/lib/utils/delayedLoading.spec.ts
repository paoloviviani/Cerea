import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelayedLoadingMachine } from "./delayedLoading";

describe("delayed loading machine", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function make() {
		const changes: boolean[] = [];
		const machine = createDelayedLoadingMachine((v) => changes.push(v), {
			delayMs: 150,
			minMs: 300,
		});
		return { changes, machine };
	}

	it("never shows for a load shorter than the delay", () => {
		const { changes, machine } = make();
		machine.set(true);
		vi.advanceTimersByTime(100);
		machine.set(false);
		vi.advanceTimersByTime(1000);
		expect(changes).toEqual([]);
	});

	it("shows after the delay and stays at least the minimum", () => {
		const { changes, machine } = make();
		machine.set(true);
		vi.advanceTimersByTime(149);
		expect(changes).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(changes).toEqual([true]);
		// the load ends 50 ms after the skeleton appeared
		vi.advanceTimersByTime(50);
		machine.set(false);
		vi.advanceTimersByTime(249);
		expect(changes).toEqual([true]);
		vi.advanceTimersByTime(1);
		expect(changes).toEqual([true, false]);
	});

	it("hides at once when the load outlasts the minimum", () => {
		const { changes, machine } = make();
		machine.set(true);
		vi.advanceTimersByTime(150 + 500);
		machine.set(false);
		vi.advanceTimersByTime(0);
		expect(changes).toEqual([true, false]);
	});

	it("keeps showing if loading restarts during the minimum", () => {
		const { changes, machine } = make();
		machine.set(true);
		vi.advanceTimersByTime(150);
		machine.set(false);
		vi.advanceTimersByTime(100);
		machine.set(true);
		vi.advanceTimersByTime(2000);
		expect(changes).toEqual([true]);
	});

	it("destroy cancels pending timers", () => {
		const { changes, machine } = make();
		machine.set(true);
		machine.destroy();
		vi.advanceTimersByTime(1000);
		expect(changes).toEqual([]);
	});
});
