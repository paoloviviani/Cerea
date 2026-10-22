import { describe, expect, it } from "vitest";
import { frameAncestorsPolicy } from "./frameAncestors";

describe("frameAncestorsPolicy", () => {
	it("allows only this origin by default, with no third-party host", () => {
		for (const v of [undefined, "", "false"]) {
			const policy = frameAncestorsPolicy(v);
			expect(policy).toBe("frame-ancestors 'self';");
			expect(policy).not.toContain("huggingface.co");
		}
	});

	it("sends no header when embedding is explicitly allowed", () => {
		expect(frameAncestorsPolicy("true")).toBeNull();
	});
});
