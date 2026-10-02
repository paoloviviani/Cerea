import { describe, expect, it } from "vitest";
import type { PermissionRule } from "$lib/types/machineProtocol";
import {
	allowedActions,
	annotateRules,
	ceilingFor,
	ceilingOf,
	notApplied,
	overriddenLabel,
	savedCount,
	sessionRulesOf,
	sourceLabel,
	summarizeTool,
	validateDraft,
} from "./permissionRules";

const rule = (
	permission: string,
	pattern: string,
	action: PermissionRule["action"],
	source?: string
): PermissionRule => ({ permission, pattern, action, ...(source ? { source } : {}) });

describe("summarizeTool", () => {
	it("is the last matching catch-all: later rules win", () => {
		const rules = [rule("edit", "*", "deny", "file"), rule("edit", "*", "ask", "cerea")];
		expect(summarizeTool(rules, "edit")).toMatchObject({ action: "ask", explicit: true });
	});

	it("lets a later wildcard permission win over an earlier specific one", () => {
		const rules = [rule("bash", "*", "allow"), rule("*", "*", "deny")];
		expect(summarizeTool(rules, "bash").action).toBe("deny");
	});

	it("asks, marked not explicit, when no rule matches (opencode's own fallback)", () => {
		expect(summarizeTool([], "webfetch")).toEqual({
			tool: "webfetch",
			action: "ask",
			explicit: false,
			narrower: 0,
		});
		expect(summarizeTool([rule("edit", "*", "allow")], "bash").explicit).toBe(false);
	});

	it("counts narrower patterns instead of letting them change the summary", () => {
		const rules = [
			rule("bash", "*", "ask"),
			rule("bash", "git *", "allow"),
			rule("bash", "rm *", "deny"),
		];
		expect(summarizeTool(rules, "bash")).toMatchObject({ action: "ask", narrower: 2 });
	});
});

describe("annotateRules", () => {
	it("marks a file rule that a later Cerea rule covers", () => {
		const out = annotateRules([
			rule("edit", "*", "deny", "file"),
			rule("edit", "*", "allow", "cerea"),
		]);
		expect(out.map((r) => r.overriddenBy)).toEqual(["cerea", undefined]);
	});

	it("does not mark a file rule that comes AFTER the Cerea rule (it is what wins)", () => {
		const out = annotateRules([
			rule("edit", "*", "allow", "cerea"),
			rule("edit", "*", "deny", "file"),
		]);
		expect(out.map((r) => r.overriddenBy)).toEqual([undefined, undefined]);
	});

	it("does not mark a file rule about something else, or a narrower Cerea rule", () => {
		const out = annotateRules([
			rule("edit", "*", "deny", "file"),
			rule("bash", "*", "ask", "cerea"),
			rule("edit", "src/**", "ask", "cerea"),
		]);
		expect(out.map((r) => r.overriddenBy)).toEqual([undefined, undefined, undefined]);
	});

	it("treats a wildcard Cerea rule as covering a specific file rule", () => {
		const out = annotateRules([
			rule("bash", "git *", "allow", "file"),
			rule("*", "*", "ask", "cerea"),
		]);
		expect(out[0].overriddenBy).toBe("cerea");
	});

	it("names the ceiling when it replaces the rule too", () => {
		const out = annotateRules([
			rule("bash", "*", "allow", "file"),
			rule("bash", "*", "ask", "cerea"),
			rule("bash", "*", "deny", "ceiling"),
		]);
		expect(out[0].overriddenBy).toBe("ceiling");
	});

	it("only ever marks the person's own file rules", () => {
		const out = annotateRules([
			rule("edit", "*", "allow", "default"),
			rule("edit", "*", "allow"),
			rule("edit", "*", "ask", "cerea"),
		]);
		expect(out.map((r) => r.overriddenBy)).toEqual([undefined, undefined, undefined]);
	});
});

describe("annotateRules: the machine's vocabulary", () => {
	it("reads opencode's source as the person's config, and machine/floor as overriders", () => {
		const out = annotateRules([
			rule("edit", "*", "allow", "opencode"),
			rule("edit", "*", "ask", "machine"),
			rule("bash", "*", "allow", "opencode"),
			rule("bash", "*", "ask", "floor"),
		]);
		expect(out.map((r) => r.overriddenBy)).toEqual(["machine", undefined, "floor", undefined]);
		expect(overriddenLabel("machine")).toBe("overridden by this machine's rules");
		expect(overriddenLabel("floor")).toBe("overridden by this machine's floor");
		expect(overriddenLabel("cerea")).toBe("overridden by Cerea");
		expect(overriddenLabel("ceiling")).toBe("overridden by this machine's limits");
	});

	it("names the last overrider, the one that wins", () => {
		const out = annotateRules([
			rule("bash", "*", "allow", "opencode"),
			rule("bash", "*", "allow", "cerea"),
			rule("bash", "*", "ask", "ceiling"),
		]);
		expect(out[0].overriddenBy).toBe("ceiling");
	});

	it("never marks a rule that carries no source", () => {
		const out = annotateRules([rule("edit", "*", "deny"), rule("edit", "*", "allow", "cerea")]);
		expect(out.map((r) => r.overriddenBy)).toEqual([undefined, undefined]);
	});

	// Documented limit: the match is literal. A later broader glob that opencode
	// WOULD match is not recognised, so the earlier rule is shown as in force.
	// The error is one-sided: it never hides a rule that is really in force.
	it("does not treat a later glob as covering an earlier literal (documented)", () => {
		const out = annotateRules([
			rule("bash", "git status", "allow", "opencode"),
			rule("bash", "git *", "ask", "cerea"),
		]);
		expect(out[0].overriddenBy).toBeUndefined();
	});
});

describe("sourceLabel", () => {
	it("labels every source the machine uses, the floor included, and says nothing for none", () => {
		expect(sourceLabel("floor")).toBe("this machine's floor");
		expect(sourceLabel("machine")).toBe("this machine's rules");
		expect(sourceLabel("ceiling")).toBe("this machine's limits");
		expect(sourceLabel("cerea")).toBe("Cerea");
		expect(sourceLabel("opencode")).toBe("opencode's rules");
		expect(sourceLabel(undefined)).toBe("");
	});
});

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

	it("offers nothing above it, and everything where nothing is capped", () => {
		const ceiling = { bash: "ask", edit: "deny" } as const;
		expect(allowedActions(ceiling, "bash")).toEqual(["ask", "deny"]);
		expect(allowedActions(ceiling, "edit")).toEqual(["deny"]);
		expect(allowedActions(ceiling, "webfetch")).toEqual(["allow", "ask", "deny"]);
		expect(allowedActions({ "*": "ask" }, "anything")).toEqual(["ask", "deny"]);
		expect(ceilingFor({ bash: "ask", "*": "deny" }, "bash")).toBe("ask");
	});
});

describe("the session's rules draft", () => {
	it("starts from the rules Cerea has in force, as plain triples", () => {
		expect(
			sessionRulesOf([
				rule("edit", "*", "allow", "opencode"),
				rule("bash", "git *", "ask", "cerea"),
			])
		).toEqual([{ permission: "bash", pattern: "git *", action: "ask" }]);
	});

	it("flags a rule above the ceiling, an empty name or pattern, and a bad name", () => {
		const ceiling = { bash: "ask" } as const;
		expect(validateDraft([{ permission: "bash", pattern: "*", action: "ask" }], ceiling)).toEqual(
			[]
		);
		const over = validateDraft([{ permission: "bash", pattern: "*", action: "allow" }], ceiling);
		expect(over).toHaveLength(1);
		expect(over[0].message).toContain('at most "ask"');
		expect(validateDraft([{ permission: " ", pattern: "*", action: "ask" }], {})).toHaveLength(1);
		expect(validateDraft([{ permission: "edit", pattern: " ", action: "ask" }], {})).toHaveLength(
			1
		);
		expect(
			validateDraft([{ permission: "no spaces", pattern: "*", action: "ask" }], {})
		).toHaveLength(1);
	});

	it("reports what the machine did not apply as asked", () => {
		const asked = [
			{ permission: "bash", pattern: "*", action: "allow" as const },
			{ permission: "edit", pattern: "*", action: "allow" as const },
			{ permission: "webfetch", pattern: "*", action: "ask" as const },
		];
		const inForce = [
			{ permission: "bash", pattern: "*", action: "ask" as const },
			{ permission: "edit", pattern: "*", action: "allow" as const },
		];
		expect(notApplied(asked, inForce)).toEqual([
			{ asked: asked[0], inForce: "ask" },
			{ asked: asked[2], inForce: null },
		]);
		expect(notApplied(asked.slice(1, 2), inForce)).toEqual([]);
	});
});

describe("savedCount", () => {
	it("counts a tool's saved approvals", () => {
		const savedApprovals = [
			{ id: "a", permission: "bash", patterns: [] },
			{ id: "b", permission: "bash", patterns: [] },
			{ id: "c", permission: "edit", patterns: [] },
		];
		expect(savedCount({ savedApprovals }, "bash")).toBe(2);
		expect(savedCount({ savedApprovals }, "webfetch")).toBe(0);
	});
});
