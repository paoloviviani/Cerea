import { describe, expect, it } from "vitest";
import * as codeApi from "./codeApi";

/**
 * The panel's reach into permissions, as a closed list. The functions in
 * `codeApi` that touch them are the reply to a pending ask, the read of the
 * rules, the session's own rules (which the machine caps by its ceiling) and
 * the removal of a saved approval (which can only tighten). Nothing writes the
 * ceiling, the machine's own rules or its policy. A new export about rules,
 * approvals or permissions fails here, so adding one is a decision a reviewer
 * sees rather than a side effect.
 */
describe("codeApi's permission surface", () => {
	it("is exactly the known list: no export for the ceiling, the machine's rules or policy", () => {
		const touching = Object.keys(codeApi).filter((name) =>
			/permission|approval|rule|ceiling|policy/i.test(name)
		);
		expect(touching.sort()).toEqual(
			[
				"getPermissionRules",
				"listPendingApprovals",
				"removeSavedApproval",
				"respondPermission",
				"setSessionRules",
			].sort()
		);
	});
});
