import { describe, expect, it } from "vitest";
import { RateLimit } from "../src/main/rateLimit.ts";

describe("popup rate limit", () => {
	it("lets five through in ten seconds, then none, then some again", () => {
		let t = 0;
		const r = new RateLimit(5, 10_000, () => t);
		expect([1, 2, 3, 4, 5, 6, 7].map(() => r.take())).toEqual([
			true,
			true,
			true,
			true,
			true,
			false,
			false,
		]);
		t = 10_001;
		expect(r.take()).toBe(true);
	});
});
