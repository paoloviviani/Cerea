import { beforeEach, describe, expect, it } from "vitest";
import {
	PAGE_CALLS_BURST,
	PAGE_CALLS_PER_MINUTE,
	pageCallAllowed,
	resetPageCallLimit,
} from "./pageCallLimit";

describe("the page call limit", () => {
	beforeEach(resetPageCallLimit);

	it("lets an autosave every second, with a user's clicks on top, run for minutes", () => {
		let now = 1_000_000;
		for (let second = 0; second < 180; second += 1) {
			expect(pageCallAllowed("k", now)).toBe(true);
			// A click and a refresh now and then, in the same second as the save.
			if (second % 3 === 0) {
				expect(pageCallAllowed("k", now + 10)).toBe(true);
				expect(pageCallAllowed("k", now + 20)).toBe(true);
			}
			now += 1000;
		}
	});

	it("allows a page's parallel reads at load, and stops a loop in the same second", () => {
		for (let i = 0; i < PAGE_CALLS_BURST; i += 1) expect(pageCallAllowed("b", 5000)).toBe(true);
		expect(pageCallAllowed("b", 5000)).toBe(false);
	});

	it("still has a per-minute ceiling", () => {
		let allowed = 0;
		for (let i = 0; i < PAGE_CALLS_PER_MINUTE + 20; i += 1) {
			if (pageCallAllowed("m", 10_000 + i * 400)) allowed += 1;
		}
		expect(allowed).toBeLessThanOrEqual(PAGE_CALLS_PER_MINUTE);
		expect(allowed).toBeGreaterThan(0);
	});
});
