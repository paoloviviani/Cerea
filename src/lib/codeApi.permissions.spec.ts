import { describe, expect, it } from "vitest";
import * as codeApi from "./codeApi";

/**
 * The panel never writes a permission rule. This is the guardrail on the
 * client's side of that promise: the only functions in `codeApi` that touch
 * permissions are the reply to a pending ask, the read of the rules, and the
 * removal of a saved approval (which can only tighten). A new export about
 * rules, approvals or permissions fails here, so adding one is a decision a
 * reviewer sees rather than a side effect.
 */
describe("codeApi's permission surface", () => {
	it("has no export that adds or edits a rule", () => {
		const touching = Object.keys(codeApi).filter((name) => /permission|approval|rule/i.test(name));
		expect(touching.sort()).toEqual(
			[
				"getPermissionRules",
				"listPendingApprovals",
				"removeSavedApproval",
				"respondPermission",
			].sort()
		);
	});
});
