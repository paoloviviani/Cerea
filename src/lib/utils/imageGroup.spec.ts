import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageGroupMachine } from "./imageGroup";

describe("image group", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("holds every tile until all have settled", () => {
		const g = createImageGroupMachine(() => {});
		for (const id of ["a", "b", "c"]) g.register(id);
		expect(g.loading).toBe(true);
		g.settle("a", true);
		g.settle("b", true);
		expect(g.loading).toBe(true);
		g.settle("c", true);
		expect(g.loading).toBe(false);
		expect(g.state("a")).toBe("loaded");
	});

	it("a failed tile settles too, so it cannot hold the others", () => {
		const g = createImageGroupMachine(() => {});
		g.register("a");
		g.register("b");
		g.settle("a", true);
		g.settle("b", false);
		expect(g.loading).toBe(false);
		expect(g.state("b")).toBe("failed");
	});

	it("lets the loaded ones show after the cap, however slow the last one is", () => {
		const g = createImageGroupMachine(() => {}, 2000);
		g.register("a");
		g.register("b");
		g.settle("a", true);
		vi.advanceTimersByTime(1999);
		expect(g.loading).toBe(true);
		vi.advanceTimersByTime(2);
		expect(g.loading).toBe(false);
		expect(g.state("b")).toBe("pending");
	});

	it("is not loading with no tiles, and drops a removed tile", () => {
		const g = createImageGroupMachine(() => {});
		expect(g.loading).toBe(false);
		g.register("a");
		g.unregister("a");
		expect(g.loading).toBe(false);
	});
});
