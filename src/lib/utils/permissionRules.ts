/**
 * The machine's limits as the Permissions sheet and the approval cards read them: the ceiling
 * (`permission.max` in the machine's hello) per permission key, Nothing here writes anything.
 */
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
