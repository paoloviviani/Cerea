import { describe, expect, it } from "vitest";
import { createSemaphore } from "./thumbnail";

describe("createSemaphore", () => {
	it("never runs more than its limit at once, and runs every task in order", async () => {
		const run = createSemaphore(2);
		let active = 0;
		let peak = 0;
		const started: number[] = [];
		const task = (n: number) =>
			run(async () => {
				started.push(n);
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return n;
			});
		const results = await Promise.all([1, 2, 3, 4, 5, 6].map(task));
		expect(results).toEqual([1, 2, 3, 4, 5, 6]);
		expect(peak).toBe(2);
		expect(started).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("lets the next task in when one fails", async () => {
		const run = createSemaphore(1);
		const failing = run(async () => {
			throw new Error("boom");
		});
		const next = run(async () => "ok");
		await expect(failing).rejects.toThrow("boom");
		await expect(next).resolves.toBe("ok");
	});
});
