/**
 * Reading opencode's rules for the Permissions line.
 *
 * opencode decides: the LAST matching rule wins, and with no match it asks.
 * These helpers describe a list the machine already composed (lowest to
 * highest precedence); nothing here evaluates a real tool call. The one thing
 * they help produce is the session's own rules (`validateDraft`), which the
 * machine still caps by its ceiling: the panel offers nothing above the
 * ceiling, and shows what is in force afterwards, never what it asked for.
 */
import type {
	PermissionRule,
	PermissionRulesResult,
	Policy,
	SessionRuleInput,
} from "$lib/types/machineProtocol";

/** The tools the line summarises. Other permission names still appear in the
 * expanded list; these three are the ones a person asks about. */
export const SUMMARY_TOOLS = ["edit", "bash", "webfetch"] as const;

export type RuleAction = PermissionRule["action"];

export interface ToolSummary {
	tool: string;
	/** The action for this tool's catch-all pattern: the last rule that
	 * names the tool (or `*`) with the pattern `*`; `ask` when none does,
	 * which is what opencode itself does with no match. */
	action: RuleAction;
	/** Whether any rule said so, as opposed to opencode's fallback. */
	explicit: boolean;
	/** Rules for this tool with a narrower pattern (`git *`): they refine the
	 * summary, so the line says how many instead of hiding them. */
	narrower: number;
}

export function summarizeTool(rules: PermissionRule[], tool: string): ToolSummary {
	let action: RuleAction = "ask";
	let explicit = false;
	let narrower = 0;
	for (const rule of rules) {
		if (rule.permission !== tool && rule.permission !== "*") continue;
		if (rule.pattern === "*") {
			action = rule.action;
			explicit = true;
		} else if (rule.permission === tool) {
			narrower += 1;
		}
	}
	return { tool, action, explicit, narrower };
}

export interface AnnotatedRule extends PermissionRule {
	/** Set on a rule a later rule from a higher-precedence source replaces:
	 * that rule's source ("cerea", "machine", "floor", "ceiling"). Only ever
	 * set for rules from the person's own config (`file` / `opencode`). */
	overriddenBy?: string;
}

/** The sources whose rules are the person's own config, which later sources
 * can replace. "opencode" lumps opencode's defaults, the config file and the
 * agent's config together, so it is treated alike. */
const OVERRIDABLE = new Set(["file", "opencode"]);
/** The sources that outrank them when they cover a rule. */
const OVERRIDERS = new Set(["cerea", "machine", "floor", "ceiling"]);

/**
 * Whether `later` covers everything `rule` covers, so that it wins wherever
 * `rule` would have applied.
 *
 * This is deliberately literal. `*` on the later rule covers anything, and an
 * identical string covers itself; nothing else is understood as a glob. A
 * later `git *` does NOT cover an earlier `git status`, and a later `src/**`
 * does not cover `src/a.ts`, even though opencode would match them. The cost
 * is one-sided and safe: a rule might be shown as still in force when a
 * broader later glob in fact replaced it, never the reverse. The list order
 * is the machine's word either way.
 */
function covers(later: PermissionRule, rule: PermissionRule): boolean {
	const samePermission = later.permission === "*" || later.permission === rule.permission;
	const samePattern = later.pattern === "*" || later.pattern === rule.pattern;
	return samePermission && samePattern;
}

/** Marks the rules the person wrote in opencode's own config that Cerea, the
 * machine's own rules, the floor or the ceiling replace. The order is the
 * machine's: a rule is overridden by a LATER rule from one of those sources
 * that covers it, and the one named is the last such rule (it is the one that
 * wins). A rule with no `source` is shown plainly, never as overridden. */
export function annotateRules(rules: PermissionRule[]): AnnotatedRule[] {
	return rules.map((rule, index) => {
		if (!rule.source || !OVERRIDABLE.has(rule.source)) return rule;
		let by: string | undefined;
		for (const later of rules.slice(index + 1)) {
			if (!later.source || !OVERRIDERS.has(later.source)) continue;
			if (covers(later, rule)) by = later.source;
		}
		return by ? { ...rule, overriddenBy: by } : rule;
	});
}

/** "overridden by Cerea", "overridden by this machine's limits", … */
export function overriddenLabel(by: string): string {
	return by === "cerea" ? "overridden by Cerea" : `overridden by ${sourceLabel(by)}`;
}

export function sourceLabel(source: string | undefined): string {
	switch (source) {
		case "cerea":
			return "Cerea";
		case "machine":
			return "this machine's rules";
		case "ceiling":
			return "this machine's limits";
		case "floor":
			return "this machine's floor";
		case "file":
		case "opencode":
			return "opencode's rules";
		case "default":
			return "opencode's default";
		default:
			return source ?? "";
	}
}

// -- the ceiling, saved approvals, and the session's own rules ---------------

const RANK: Record<RuleAction, number> = { deny: 0, ask: 1, allow: 2 };
const ALL_ACTIONS: RuleAction[] = ["allow", "ask", "deny"];

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

/** The most permissive action a rule for `permission` may carry, or null when
 * the machine caps nothing for it. A `*` entry caps every key it does not name. */
export function ceilingFor(
	ceiling: Record<string, "ask" | "deny">,
	permission: string
): RuleAction | null {
	return ceiling[permission] ?? ceiling["*"] ?? null;
}

/** The actions the panel offers for `permission`: never above the ceiling.
 * The machine caps anyway; this only keeps the panel from offering what it
 * knows will be lowered or refused. */
export function allowedActions(
	ceiling: Record<string, "ask" | "deny">,
	permission: string
): RuleAction[] {
	const max = ceilingFor(ceiling, permission);
	return max === null ? ALL_ACTIONS : ALL_ACTIONS.filter((action) => RANK[action] <= RANK[max]);
}

/** Saved "always" approvals held for one tool, for the count on its pill. */
export function savedCount(result: Pick<PermissionRulesResult, "savedApprovals">, tool: string) {
	return result.savedApprovals.filter((approval) => approval.permission === tool).length;
}

/** The rules the person (through Cerea) has in force for this session: what
 * the editor starts from. */
export function sessionRulesOf(rules: PermissionRule[]): SessionRuleInput[] {
	return rules
		.filter((rule) => rule.source === "cerea")
		.map(({ permission, pattern, action }) => ({ permission, pattern, action }));
}

export interface DraftProblem {
	index: number;
	message: string;
}

/** Why a draft cannot be sent, one entry per offending row; empty when it can.
 * Mirrors what the forwarder and the machine accept, so a refusal is rare and
 * the message is written for the person editing. */
export function validateDraft(
	draft: SessionRuleInput[],
	ceiling: Record<string, "ask" | "deny">
): DraftProblem[] {
	const problems: DraftProblem[] = [];
	draft.forEach((rule, index) => {
		const permission = rule.permission.trim();
		if (!permission) {
			problems.push({ index, message: "Name the permission (edit, bash, webfetch, …)." });
		} else if (!/^[A-Za-z0-9_.:*-]+$/.test(permission) || permission.length > 64) {
			problems.push({ index, message: `"${permission}" is not a permission name.` });
		}
		if (!rule.pattern.trim()) {
			problems.push({ index, message: "A pattern is required; use * for everything." });
		}
		const max = ceilingFor(ceiling, permission);
		if (max !== null && RANK[rule.action] > RANK[max]) {
			problems.push({
				index,
				message: `${permission} may be at most "${max}" on this machine.`,
			});
		}
	});
	if (draft.length > 64) problems.push({ index: -1, message: "At most 64 rules." });
	return problems;
}

/** Where what was asked for and what is in force differ, after a write: the
 * rows the machine lowered, dropped or changed. Compared by permission and
 * pattern against the session's `cerea` rules as re-read. Empty means the
 * machine applied exactly what was asked. */
export function notApplied(
	asked: SessionRuleInput[],
	inForce: SessionRuleInput[]
): Array<{ asked: SessionRuleInput; inForce: RuleAction | null }> {
	const out: Array<{ asked: SessionRuleInput; inForce: RuleAction | null }> = [];
	for (const rule of asked) {
		const got = inForce.find(
			(candidate) => candidate.permission === rule.permission && candidate.pattern === rule.pattern
		);
		if (!got || got.action !== rule.action) out.push({ asked: rule, inForce: got?.action ?? null });
	}
	return out;
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
