/**
 * Reading opencode's rules for the Permissions line.
 *
 * opencode decides: the LAST matching rule wins, and with no match it asks.
 * These helpers only describe a list the machine already composed (lowest to
 * highest precedence); nothing here evaluates a real tool call, and nothing
 * produces a rule to send anywhere.
 */
import type { PermissionRule } from "$lib/types/machineProtocol";

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
	 * who replaced it. Only ever set for a person's own file rule. */
	overriddenBy?: "cerea" | "ceiling";
}

/** Whether `later` covers everything `rule` covers, so that it wins wherever
 * `rule` would have applied. */
function covers(later: PermissionRule, rule: PermissionRule): boolean {
	const samePermission = later.permission === "*" || later.permission === rule.permission;
	const samePattern = later.pattern === "*" || later.pattern === rule.pattern;
	return samePermission && samePattern;
}

/** Marks the rules the person wrote in opencode's own config that Cerea (or
 * the machine's ceiling) overrides. The order is the machine's: a rule is
 * overridden by a LATER rule from Cerea or the ceiling that covers it. */
export function annotateRules(rules: PermissionRule[]): AnnotatedRule[] {
	return rules.map((rule, index) => {
		if (rule.source !== "file") return rule;
		let by: AnnotatedRule["overriddenBy"];
		for (const later of rules.slice(index + 1)) {
			if (later.source !== "cerea" && later.source !== "ceiling") continue;
			if (!covers(later, rule)) continue;
			// The ceiling outranks Cerea, so it is the one named when both apply.
			if (later.source === "ceiling") by = "ceiling";
			else by ??= "cerea";
		}
		return by ? { ...rule, overriddenBy: by } : rule;
	});
}

export function sourceLabel(source: string | undefined): string {
	switch (source) {
		case "cerea":
			return "Cerea";
		case "ceiling":
			return "this machine's limits";
		case "file":
			return "your opencode config";
		case "default":
			return "opencode's default";
		default:
			return source ?? "";
	}
}
