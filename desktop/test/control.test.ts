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
});
