import { describe, expect, it } from "vitest";
import type { PermissionRule } from "$lib/types/machineProtocol";
import { annotateRules, summarizeTool } from "./permissionRules";

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
