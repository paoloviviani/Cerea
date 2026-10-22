import { describe, expect, it } from "vitest";
import { bundleProblems } from "../../../scripts/check-bundle.mjs";

describe("production bundle check", () => {
	const kept =
		"const a=1;uu({get registry(){return e(U)},get fileRegistry(){return e(Ue)},panel:q,get requestFix(){return 1}});";

	it("accepts a bundle that still makes the artifacts context call", () => {
		expect(bundleProblems(["const x=1", kept])).toEqual([]);
	});

	it("rejects a bundle where the call was deleted", () => {
		expect(bundleProblems(["const x=1", "function uu(n){gi(rd,n)}"])).toHaveLength(1);
		expect(bundleProblems([])).toHaveLength(1);
	});
});
