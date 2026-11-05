import { describe, expect, it } from "vitest";
import type { PermissionRule } from "$lib/types/machineProtocol";
import {
	ceilingEmpty,
	ceilingFor,
	ceilingOfPolicy,
	isCapped,
	hasFileRules,
	isLegacyMachine,
	ceilingOf,
} from "./permissionRules";

const rule = (
	permission: string,
	pattern: string,
	action: PermissionRule["action"],
	source?: string
): PermissionRule => ({ permission, pattern, action, ...(source ? { source } : {}) });

describe("the ceiling", () => {
	it("is the machine's own map, else read from its ceiling-sourced catch-alls", () => {
		expect(ceilingOf({ rules: [], ceiling: { bash: "ask" } })).toEqual({ bash: "ask" });
		expect(
			ceilingOf({
				rules: [
					rule("edit", "*", "deny", "ceiling"),
					rule("bash", "git *", "ask", "ceiling"),
					rule("webfetch", "*", "allow", "ceiling"),
					rule("bash", "*", "ask", "cerea"),
				],
				ceiling: {},
			})
		).toEqual({ edit: "deny" });
	});

	it("caps a key by its own entry, else by `*`, else not at all", () => {
		expect(ceilingFor({ bash: "ask", "*": "deny" }, "bash")).toBe("ask");
		expect(ceilingFor({ bash: "ask", "*": "deny" }, "edit")).toBe("deny");
		expect(ceilingFor({ bash: "ask" }, "edit")).toBeNull();
	});

	it("reads the ceiling out of hello's policy, keeping only the two words that cap", () => {
		expect(
			ceilingOfPolicy({
				workspaceRoots: [],
				allowFreeModels: false,
				permission: { max: { bash: "ask", edit: "deny", webfetch: "allow", x: "weird" } },
			})
		).toEqual({ bash: "ask", edit: "deny" });
		expect(ceilingOfPolicy(undefined)).toEqual({});
	});

	it("says a key is capped when its ceiling is below allow: its Always would store nothing", () => {
		const ceiling = { bash: "ask", edit: "deny" } as const;
		expect(isCapped(ceiling, "bash")).toBe(true);
		expect(isCapped(ceiling, "edit")).toBe(true);
		expect(isCapped(ceiling, "webfetch")).toBe(false);
		expect(isCapped({ "*": "ask" }, "anything")).toBe(true);
		expect(isCapped({}, "bash")).toBe(false);
	});
});

describe("legacy machines", () => {
	const BASE = { workspaceRoots: [], allowFreeModels: false };
	const EMPTY = { ...BASE, permission: { max: {} } };
	const ENROLLED = { ...BASE, permission: { max: { bash: "ask" } } };
	const ALLOW_ALL = [rule("*", "*", "allow", "opencode")];
	const WITH_ASK_BLOCK = [
		rule("*", "*", "allow", "opencode"),
		rule("edit", "*", "ask", "file"),
		rule("bash", "*", "ask", "file"),
		rule("webfetch", "*", "ask", "file"),
	];

	it("reads an empty or missing ceiling in hello as no ceiling", () => {
		expect(ceilingEmpty(EMPTY)).toBe(true);
		expect(ceilingEmpty({ ...BASE, permission: {} })).toBe(true);
		expect(ceilingEmpty(undefined)).toBe(true);
		expect(ceilingEmpty(ENROLLED)).toBe(false);
	});

	it("tells opencode's built-in allow-all from rules the machine's file carries", () => {
		expect(hasFileRules(ALLOW_ALL)).toBe(false);
		expect(hasFileRules(WITH_ASK_BLOCK)).toBe(true);
		// The lumped "opencode" source counts only when it asks or denies.
		expect(hasFileRules([rule("edit", "*", "ask", "opencode")])).toBe(true);
		expect(hasFileRules([rule("edit", "*", "allow", "opencode")])).toBe(false);
		expect(hasFileRules([rule("edit", "*", "ask", "cerea")])).toBe(false);
	});

	it("flags: empty ceiling and a rule list without file rules", () => {
		expect(isLegacyMachine(EMPTY, { rules: ALLOW_ALL, ceiling: {} })).toBe(true);
	});

	it("does not flag a properly enrolled machine", () => {
		expect(isLegacyMachine(ENROLLED, { rules: WITH_ASK_BLOCK, ceiling: { bash: "ask" } })).toBe(
			false
		);
	});

	it("needs both halves of the evidence, and never guesses without a rule list", () => {
		// A ceiling in hello, even over an allow-all list.
		expect(isLegacyMachine(ENROLLED, { rules: ALLOW_ALL, ceiling: {} })).toBe(false);
		// File rules present, even with no ceiling.
		expect(isLegacyMachine(EMPTY, { rules: WITH_ASK_BLOCK, ceiling: {} })).toBe(false);
		// The live answer reporting a ceiling clears it too.
		expect(isLegacyMachine(EMPTY, { rules: ALLOW_ALL, ceiling: { bash: "ask" } })).toBe(false);
		expect(isLegacyMachine(EMPTY, null)).toBe(false);
	});
});
