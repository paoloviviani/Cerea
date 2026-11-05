/**
 * The machine's limits as the Permissions sheet and the approval cards read them: the ceiling
 * (`permission.max` in the machine's hello) per permission key, and whether a machine predates
 * ceilings. Nothing here writes anything.
 */
import { m } from "$lib/paraglide/messages";
import type { PermissionRule, PermissionRulesResult, Policy } from "$lib/types/machineProtocol";

export type RuleAction = PermissionRule["action"];

const RANK: Record<RuleAction, number> = { deny: 0, ask: 1, allow: 2 };

// -- the ceiling and the session's exceptions --------------------------------

/** The ceiling as a permission key -> most-permissive action map. The machine
 * reports it directly (`ceiling`); a machine that does not is read from its
 * `ceiling`-sourced catch-all rules instead. Empty means "no cap known". */
export function ceilingOf(
	result: Pick<PermissionRulesResult, "rules" | "ceiling">
): Record<string, "ask" | "deny"> {
	if (Object.keys(result.ceiling).length > 0) return result.ceiling;
	const derived: Record<string, "ask" | "deny"> = {};
	for (const rule of result.rules) {
		if (rule.source === "ceiling" && rule.pattern === "*" && rule.action !== "allow") {
			derived[rule.permission] = rule.action;
		}
	}
	return derived;
}

/** The ceiling as the machine's `hello` reports it (`permission.max`), for a
 * surface that has no `permission.rules` read of its own (the inbox's cards).
 * Only the two words that cap anything are kept. */
export function ceilingOfPolicy(policy: Policy | undefined): Record<string, "ask" | "deny"> {
	const out: Record<string, "ask" | "deny"> = {};
	for (const [key, value] of Object.entries(policy?.permission?.max ?? {})) {
		if (value === "ask" || value === "deny") out[key] = value;
	}
	return out;
}

/** The most permissive action a rule for `permission` may carry, or null when
 * the machine caps nothing for it. A `*` entry caps every key it does not name. */
export function ceilingFor(
	ceiling: Record<string, "ask" | "deny">,
	permission: string
): RuleAction | null {
	return ceiling[permission] ?? ceiling["*"] ?? null;
}

/** Whether the ceiling holds `permission` below allow, so that an "Always
 * allow" for it would store nothing: the machine answers once and the next
 * call asks again. The card hides the button instead of offering it. */
export function isCapped(ceiling: Record<string, "ask" | "deny">, permission: string): boolean {
	const max = ceilingFor(ceiling, permission);
	return max !== null && RANK[max] < RANK.allow;
}

/** What the ceiling still holds back under Allow, in words: "bash asks",
 * "edit is denied". Empty when it caps nothing. The key `*` reads "everything". */
export function ceilingNote(ceiling: Record<string, "ask" | "deny">): string {
	return Object.entries(ceiling)
		.map(([key, max]) => {
			const name = key === "*" ? m["code.permissions.ceiling_everything"]() : key;
			return max === "ask"
				? m["code.permissions.ceiling_asks"]({ key: name })
				: m["code.permissions.ceiling_denied"]({ key: name });
		})
		.join(", ");
}

// -- legacy machines ---------------------------------------------------------

/** Whether the machine's `hello` reports no ceiling at all: `permission.max`
 * empty, or no `permission` policy in it. A machine enrolled with this wave's
 * `enroll` always has one (`bash=ask` by default), so empty means its
 * `policy.json` predates ceilings. */
export function ceilingEmpty(policy: Policy | undefined): boolean {
	const max = policy?.permission?.max;
	return !max || Object.keys(max).length === 0;
}

/** Whether any rule on the list comes from opencode's own config that asks or
 * denies something: the `ask` block `enroll` writes into `opencode.json` on a
 * new machine reads as "file" (or, in the machine's lumped vocabulary,
 * "opencode") rules. opencode's built-in `"*": allow` is not one: a machine
 * with only that has nothing standing between the model and the disk. */
export function hasFileRules(rules: PermissionRule[]): boolean {
	return rules.some(
		(rule) => rule.source === "file" || (rule.source === "opencode" && rule.action !== "allow")
	);
}

/**
 * A machine enrolled before this wave: legacy `policy.json` (no ceiling) and an
 * `opencode.json` with no ask block. It stays allow-everything — an edit, a
 * command, a fetch runs with no ask, subagents included — until it is
 * re-enrolled, so the panel flags it instead of showing a clean bill.
 *
 * Needs both halves of the evidence: an empty ceiling in `hello`, and a rule
 * list (from `permission.rules`, so a session) with no file rules. A live
 * ceiling in that answer clears it too. Never true without a rule list.
 */
export function isLegacyMachine(
	policy: Policy | undefined,
	result: Pick<PermissionRulesResult, "rules" | "ceiling"> | null
): boolean {
	if (!result) return false;
	return (
		ceilingEmpty(policy) && Object.keys(result.ceiling).length === 0 && !hasFileRules(result.rules)
	);
}
