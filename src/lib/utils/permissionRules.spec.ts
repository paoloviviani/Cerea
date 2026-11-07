import { describe, expect, it } from "vitest";
import type { PermissionRule } from "$lib/types/machineProtocol";
import { ceilingFor, ceilingOfPolicy, isCapped, ceilingOf } from "./permissionRules";

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
