import { describe, expect, it } from "vitest";
import type { PermissionRule, PermissionRulesResult } from "$lib/types/machineProtocol";
import {
	annotateRules,
	ceilingEmpty,
	ceilingFor,
	ceilingNote,
	ceilingOfPolicy,
	actionLabel,
	capabilityRows,
	evaluate,
	permissionSummary,
	wildcardMatch,
	type CapabilityRow,
	isCapped,
	hasFileRules,
	isLegacyMachine,
	ceilingOf,
	overriddenLabel,
	sourceLabel,
} from "./permissionRules";

const rule = (
	permission: string,
	pattern: string,
	action: PermissionRule["action"],
	source?: string
): PermissionRule => ({ permission, pattern, action, ...(source ? { source } : {}) });

describe("wildcardMatch", () => {
	it("takes * as any run and ? as one character, over the whole string", () => {
		expect(wildcardMatch("edit", "*")).toBe(true);
		expect(wildcardMatch("session_spawn", "session_*")).toBe(true);
		expect(wildcardMatch("bash", "bas?")).toBe(true);
		expect(wildcardMatch("bash", "bas")).toBe(false);
		expect(wildcardMatch("a.env", "*.env")).toBe(true);
		expect(wildcardMatch("aXenv", "*.env")).toBe(false);
	});

	it("lets a trailing ' *' match the bare command", () => {
		expect(wildcardMatch("git", "git *")).toBe(true);
		expect(wildcardMatch("git status", "git *")).toBe(true);
		expect(wildcardMatch("gitk", "git *")).toBe(false);
	});
});

describe("evaluate", () => {
	it("is the last matching rule: the user's question case, ask / allow / deny / allow, is allow", () => {
		const rules = [
			rule("question", "*", "ask", "cerea"),
			rule("question", "*", "allow", "opencode"),
			rule("question", "*", "deny", "file"),
			rule("question", "*", "allow", "cerea"),
		];
		expect(evaluate(rules, "question")).toBe("allow");
	});

	it("lets a later wildcard permission win over an earlier specific one", () => {
		expect(evaluate([rule("bash", "*", "allow"), rule("*", "*", "deny")], "bash")).toBe("deny");
		expect(evaluate([rule("*", "*", "deny"), rule("bash", "*", "allow")], "bash")).toBe("allow");
	});

	it("asks when no rule matches", () => {
		expect(evaluate([], "webfetch")).toBe("ask");
		expect(evaluate([rule("edit", "*", "allow")], "bash")).toBe("ask");
	});

	it("matches the pattern too: a narrower rule does not decide the catch-all", () => {
		const rules = [rule("bash", "*", "ask"), rule("bash", "git *", "allow")];
		expect(evaluate(rules, "bash")).toBe("ask");
		expect(evaluate(rules, "bash", "git status")).toBe("allow");
	});
});

const result = (
	rules: PermissionRule[],
	extra: Partial<PermissionRulesResult> = {}
): PermissionRulesResult => ({ rules, savedApprovals: [], ceiling: {}, ...extra });

const rowOf = (rows: CapabilityRow[], id: string) => rows.find((row) => row.id === id);

describe("capabilityRows", () => {
	it("gives one row per capability, in plain words, with the final answer", () => {
		const rows = capabilityRows(result([rule("*", "*", "ask", "cerea")]));
		expect(rows.map((row) => row.label)).toEqual([
			"Edit and write files",
			"Run commands",
			"Fetch from the web",
			"Start subagents",
			"Read files",
			"Work outside the project folder",
			"Start, message or read other sessions",
			"Ask you questions",
		]);
		expect(rows.every((row) => row.action === "ask")).toBe(true);
	});

	it("takes the last answer where the raw list repeats a permission", () => {
		const rows = capabilityRows(
			result([
				rule("lsp", "*", "ask"),
				rule("lsp", "*", "allow"),
				rule("question", "*", "ask"),
				rule("question", "*", "allow"),
				rule("question", "*", "deny"),
				rule("question", "*", "allow"),
			])
		);
		expect(rowOf(rows, "question")?.action).toBe("allow");
	});

	it("shows a search row only where it differs from the fetch row", () => {
		const same = capabilityRows(result([rule("*", "*", "allow")]));
		expect(rowOf(same, "search")).toBeUndefined();
		const differs = capabilityRows(
			result([
				rule("*", "*", "allow"),
				rule("websearch", "*", "deny"),
				rule("codesearch", "*", "deny"),
			])
		);
		expect(rowOf(differs, "search")).toMatchObject({ label: "Search the web", action: "deny" });
	});

	it("splits a row whose keys disagree", () => {
		const rows = capabilityRows(
			result([rule("*", "*", "allow"), rule("session_send", "*", "deny")])
		);
		expect(rowOf(rows, "sessions")).toBeUndefined();
		expect(rowOf(rows, "sessions:session_spawn")).toMatchObject({
			label: "Start other sessions",
			action: "allow",
		});
		expect(rowOf(rows, "sessions:session_send")).toMatchObject({
			label: "Message other sessions",
			action: "deny",
		});
		expect(rowOf(rows, "sessions:session_read")).toMatchObject({
			label: "Read other sessions",
			action: "allow",
		});
	});

	it("shows a granted read as its own row, held by the machine's ceiling", () => {
		const rows = capabilityRows(
			result([rule("*", "*", "allow", "cerea"), rule("session_read", "*", "ask", "ceiling")], {
				ceiling: { session_read: "ask" },
			})
		);
		expect(rowOf(rows, "sessions:session_read")).toMatchObject({
			label: "Read other sessions",
			action: "ask",
			capped: true,
		});
	});

	it("notes the secret files a later read rule asks about", () => {
		const rows = capabilityRows(
			result([
				rule("read", "*", "allow", "opencode"),
				rule("read", "*.env", "ask", "opencode"),
				rule("read", "*.env.*", "ask", "opencode"),
				rule("read", "*.env.example", "allow", "opencode"),
			])
		);
		expect(rowOf(rows, "read")).toMatchObject({
			action: "allow",
			except: ["secret files like .env: ask"],
		});
	});

	it("drops that note when a later catch-all replaces it", () => {
		const rows = capabilityRows(
			result([
				rule("read", "*", "allow"),
				rule("read", "*.env", "ask"),
				rule("read", "*", "deny", "ceiling"),
			])
		);
		expect(rowOf(rows, "read")).toMatchObject({ action: "deny", except: [] });
	});

	it("marks a row the ceiling holds below what the session's setting would give", () => {
		const rows = capabilityRows(
			result(
				[
					rule("*", "*", "allow", "cerea"),
					rule("bash", "*", "ask", "ceiling"),
					rule("edit", "*", "allow", "ceiling"),
				],
				{ ceiling: { bash: "ask" } }
			)
		);
		expect(rowOf(rows, "bash")).toMatchObject({ action: "ask", capped: true });
		expect(rowOf(rows, "edit")).toMatchObject({ action: "allow", capped: false });
	});

	it("is not capped when the session's own setting is already as strict", () => {
		const rows = capabilityRows(
			result([rule("*", "*", "ask", "cerea"), rule("bash", "*", "ask", "ceiling")], {
				ceiling: { bash: "ask" },
			})
		);
		expect(rowOf(rows, "bash")?.capped).toBe(false);
	});

	it("reads the reported ceiling when the rules carry no source", () => {
		const rows = capabilityRows(
			result([rule("*", "*", "ask")], { mode: "allow", ceiling: { bash: "ask" } })
		);
		expect(rowOf(rows, "bash")?.capped).toBe(true);
	});
});

describe("permissionSummary", () => {
	it("says it short and plain", () => {
		const deny = capabilityRows(result([rule("*", "*", "deny")]));
		expect(permissionSummary(deny)).toBe("Edits blocked · commands blocked · web blocked");
		const ask = capabilityRows(result([]));
		expect(permissionSummary(ask)).toBe("Edits ask · commands ask · web ask");
		const mixed = capabilityRows(result([rule("*", "*", "ask"), rule("edit", "*", "allow")]));
		expect(permissionSummary(mixed)).toBe("Edits allowed · commands ask · web ask");
	});
});

describe("actionLabel", () => {
	it("uses the three plain words", () => {
		expect(actionLabel("allow")).toBe("Allowed");
		expect(actionLabel("ask")).toBe("Asks first");
		expect(actionLabel("deny")).toBe("Blocked");
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
