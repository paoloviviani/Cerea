import { describe, expect, it } from "vitest";
import { Control, TAKEN_OVER_MESSAGE } from "../src/main/control.ts";

describe("take over and hand back", () => {
	it("lets the runtime run until the user takes over, refuses with a readable message, then resumes", async () => {
		const c = new Control();
		await expect(c.pass("Input.dispatchMouseEvent")).resolves.toBeUndefined();
		c.set("user");
		await expect(c.pass("Input.dispatchMouseEvent")).rejects.toThrow(TAKEN_OVER_MESSAGE);
		await expect(c.pass("Page.navigate")).rejects.toThrow(/taken over/);
		await expect(c.pass("Runtime.evaluate")).rejects.toThrow(/taken over/);
		// connection wiring still works, so the runtime does not break
		// nothing that watches or steers the user's tabs, wiring included
		await expect(c.pass("Target.setAutoAttach")).rejects.toThrow(/taken over/);
		await expect(c.pass("Target.activateTarget")).rejects.toThrow(/taken over/);
		await expect(c.pass("Browser.getVersion")).resolves.toBeUndefined();
		c.set("agent");
		await expect(c.pass("Page.navigate")).resolves.toBeUndefined();
	});

	it("reports activity for the Cerea-is-browsing indicator", () => {
		let t = 1000;
		const c = new Control(() => t);
		expect(c.agentBusy).toBe(false);
		c.activity();
		expect(c.agentBusy).toBe(true);
		t += 5000;
		expect(c.agentBusy).toBe(false);
		expect(c.recentlyActive(10_000)).toBe(true);
		t += 200_000;
		expect(c.recentlyActive(120_000)).toBe(false);
	});

	it("tells the app when a task starts (the first sign after 30 s of quiet), not on every step", () => {
		let t = 1_000_000;
		const c = new Control(() => t);
		let starts = 0;
		let changes = 0;
		c.onTaskStart(() => starts++);
		c.onChange(() => changes++);
		expect(c.working).toBe(false);
		c.activity();
		expect(starts).toBe(1);
		expect(c.working).toBe(true);
		t += 10_000;
		c.activity();
		t += 25_000;
		c.activity(); // 25 s after the last one: still the same task
		expect(starts).toBe(1);
		t += 31_000;
		expect(c.working).toBe(false);
		c.activity(); // a new task
		expect(starts).toBe(2);
		expect(changes).toBeGreaterThan(0);
	});
});

describe("a second runtime on the panel", () => {
	it("a task is active only from the runtime's own commands, not from the window browser's touch", () => {
		let t = 1_000_000;
		const c = new Control(() => t);
		expect(c.taskActive()).toBe(false);
		// the window browser opens the panel before its runtime has connected
		c.touch();
		expect(c.working).toBe(true);
		expect(c.taskActive()).toBe(false);
		c.activity();
		expect(c.taskActive()).toBe(true);
		t += 31_000;
		expect(c.taskActive()).toBe(false);
	});

	it("remembers a refusal for a moment, for the window browser's wording", () => {
		let t = 1_000_000;
		const c = new Control(() => t);
		expect(c.recentlyRefused(20_000)).toBe(false);
		c.refused();
		expect(c.recentlyRefused(20_000)).toBe(true);
		t += 21_000;
		expect(c.recentlyRefused(20_000)).toBe(false);
	});
});
