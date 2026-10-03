import { describe, expect, it } from "vitest";
import type { PermissionRule } from "$lib/types/machineProtocol";
import {
	annotateRules,
	ceilingEmpty,
	ceilingFor,
	ceilingNote,
	ceilingOfPolicy,
	exceptionCount,
	isCapped,
	hasFileRules,
	isLegacyMachine,
	ceilingOf,
	overriddenLabel,
	sourceLabel,
	summarizeTool,
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

	it("names what the ceiling still holds back, for the selector's note", () => {
		expect(ceilingNote({ bash: "ask" })).toBe("bash asks");
		expect(ceilingNote({ bash: "ask", edit: "deny" })).toBe("bash asks, edit is denied");
		expect(ceilingNote({ "*": "ask" })).toBe("everything asks");
		expect(ceilingNote({})).toBe("");
	});
});

describe("exceptionCount", () => {
	it("counts a tool's exceptions", () => {
		const savedApprovals = [
			{ id: "a", permission: "bash", patterns: [] },
			{ id: "b", permission: "bash", patterns: [] },
			{ id: "c", permission: "edit", patterns: [] },
		];
		expect(exceptionCount({ savedApprovals }, "bash")).toBe(2);
		expect(exceptionCount({ savedApprovals }, "webfetch")).toBe(0);
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
