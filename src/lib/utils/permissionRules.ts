/**
 * Reading opencode's rules for the Permissions line.
 *
 * opencode decides: the LAST matching rule wins, and with no match it asks.
 * These helpers read a list the machine already composed (lowest to highest
 * precedence, the ceiling's tail included): `capabilityRows` works out the
 * final answer per capability the way opencode would (for the pattern `*`,
 * never for a real tool call), and `annotateRules` marks what the raw list
 * overrides. Nothing here writes a rule: the panel's own writes are the
 * session's mode and the removal of an exception, neither of which is a rule.
 */
import type { PermissionRule, PermissionRulesResult, Policy } from "$lib/types/machineProtocol";

export type RuleAction = PermissionRule["action"];

const RANK: Record<RuleAction, number> = { deny: 0, ask: 1, allow: 2 };

/**
 * opencode's Wildcard.match, as `agent/internal/permrules` (`Match`) has it:
 * `*` is any run, `?` any one character, the whole string must match, and a
 * trailing " *" also matches the bare command ("ls *" matches "ls"). Backslashes
 * are slashes.
 */
export function wildcardMatch(value: string, pattern: string): boolean {
	const s = value.replaceAll("\\", "/");
	let p = pattern.replaceAll("\\", "/");
	const trailing = p.endsWith(" *");
	if (trailing) p = p.slice(0, -2);
	let source = "^";
	for (const ch of p) {
		if (ch === "*") source += ".*";
		else if (ch === "?") source += ".";
		else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	if (trailing) source += "( .*)?";
	source += "$";
	return new RegExp(source, "s").test(s);
}

/** opencode's resolution (`Evaluate` in permrules): the action of the LAST
 * rule whose permission and pattern both match, and ask when none does. */
export function evaluate(rules: PermissionRule[], permission: string, pattern = "*"): RuleAction {
	for (let i = rules.length - 1; i >= 0; i--) {
		const rule = rules[i];
		if (wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) {
			return rule.action;
		}
	}
	return "ask";
}

// -- the capabilities, in plain words ------------------------------------------

interface CapabilitySpec {
	id: string;
	label: string;
	keys: string[];
	/** When the keys' answers differ: a row per key, with these labels. */
	split?: string[];
	/** Left out when its answer is the same as that row's: the keys are
	 * folded into it instead of repeating it. */
	foldInto?: string;
}

const CAPABILITIES: CapabilitySpec[] = [
	{ id: "edit", label: "Edit and write files", keys: ["edit"] },
	{ id: "bash", label: "Run commands", keys: ["bash"] },
	{ id: "web", label: "Fetch from the web", keys: ["webfetch"] },
	{
		id: "search",
		label: "Search the web",
		keys: ["websearch", "codesearch"],
		split: ["Search the web", "Search code"],
		foldInto: "web",
	},
	{ id: "task", label: "Start subagents", keys: ["task"] },
	{ id: "read", label: "Read files", keys: ["read"] },
	{ id: "external", label: "Work outside the project folder", keys: ["external_directory"] },
	{
		id: "sessions",
		label: "Start or message other sessions",
		keys: ["session_spawn", "session_send"],
		split: ["Start other sessions", "Message other sessions"],
	},
	{ id: "question", label: "Ask you questions", keys: ["question"] },
];

export interface CapabilityRow {
	id: string;
	label: string;
	/** What happens in this session right now. */
	action: RuleAction;
	/** The machine's limits are what hold it below what the session's own
	 * setting would give. */
	capped: boolean;
	/** For `read`: narrower patterns that answer more strictly than the
	 * rest, e.g. "secret files like .env: ask". */
	except: string[];
}

/** What the answer would be if the machine's ceiling said nothing. */
function withoutCeiling(rules: PermissionRule[]): PermissionRule[] {
	return rules.filter((rule) => rule.source !== "ceiling");
}

function isCappedKey(result: PermissionRulesResult, key: string, answer: RuleAction): boolean {
	if (result.rules.some((rule) => rule.source === "ceiling")) {
		return RANK[evaluate(withoutCeiling(result.rules), key)] > RANK[answer];
	}
	// A machine whose rules carry no source: the ceiling it reports is all
	// there is to go by, and it bites when Allow is held at it.
	const max = ceilingOf(result)[key] ?? ceilingOf(result)["*"];
	return result.mode === "allow" && max !== undefined && answer === max;
}

const SECRET_FILE = /\.env/;

/** The narrower `read` patterns that answer stricter than the catch-all,
 * worded for a person: ".env" files are "secret files like .env". */
function readExceptions(rules: PermissionRule[], answer: RuleAction): string[] {
	const patterns = new Set<string>();
	for (const rule of rules) {
		if (rule.pattern !== "*" && wildcardMatch("read", rule.permission)) patterns.add(rule.pattern);
	}
	const byAction = new Map<RuleAction, string[]>();
	for (const pattern of patterns) {
		const got = evaluate(rules, "read", pattern);
		if (RANK[got] >= RANK[answer]) continue;
		const name = SECRET_FILE.test(pattern) ? "secret files like .env" : pattern;
		const names = byAction.get(got) ?? [];
		if (!names.includes(name)) names.push(name);
		byAction.set(got, names);
	}
	return [...byAction].map(([action, names]) => `${names.join(", ")}: ${action}`);
}

/**
 * The final answer per capability: what this session does right now, worked
 * out the way opencode does (last matching rule, ask by default) from the
 * rules the machine composed, which already carry the ceiling's tail. Keys
 * that answer alike are one row.
 */
export function capabilityRows(result: PermissionRulesResult): CapabilityRow[] {
	const rows: CapabilityRow[] = [];
	for (const spec of CAPABILITIES) {
		const answers = spec.keys.map((key) => evaluate(result.rules, key));
		const folded = rows.find((row) => row.id === spec.foldInto);
		const same = answers.every((answer) => answer === answers[0]);
		if (folded && same && answers[0] === folded.action) continue;
		const groups = same || !spec.split ? [spec.keys] : spec.keys.map((key) => [key]);
		groups.forEach((keys, index) => {
			const action = evaluate(result.rules, keys[0]);
			rows.push({
				id: groups.length > 1 ? `${spec.id}:${keys[0]}` : spec.id,
				label: groups.length > 1 && spec.split ? spec.split[index] : spec.label,
				action,
				capped: keys.some((key) => isCappedKey(result, key, evaluate(result.rules, key))),
				except: spec.id === "read" ? readExceptions(result.rules, action) : [],
			});
		});
	}
	return rows;
}

/** "Allowed", "Asks first", "Blocked": the row's answer in a word. */
export function actionLabel(action: RuleAction): string {
	return action === "allow" ? "Allowed" : action === "deny" ? "Blocked" : "Asks first";
}

/** The collapsed line: "Edits blocked · commands blocked · web blocked". */
export function permissionSummary(rows: CapabilityRow[]): string {
	const word = (action: RuleAction) =>
		action === "allow" ? "allowed" : action === "deny" ? "blocked" : "ask";
	const parts: Array<[string, string]> = [
		["edit", "Edits"],
		["bash", "commands"],
		["web", "web"],
	];
	return parts
		.flatMap(([id, noun]) => {
			const row = rows.find((candidate) => candidate.id === id);
			return row ? [`${noun} ${word(row.action)}`] : [];
		})
		.join(" · ");
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
		.map(
			([key, max]) => `${key === "*" ? "everything" : key} ${max === "ask" ? "asks" : "is denied"}`
		)
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
