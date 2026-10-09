/**
 * The machine-policy half of the Pair-a-machine dialog: what a person can
 * choose, which `galopin enroll` flags that turns into, and the `policy.json`
 * the machine will then hold.
 *
 * Pure, so it has its own specs independent of rendering. Three rules it
 * keeps, each pinned in `codeEnrollPolicy.spec.ts`:
 *
 * - a default emits **nothing**: the printed command carries a flag only for
 *   a choice that differs from what `enroll` does on its own;
 * - the ceiling flag **replaces** enroll's default set (bash asks) rather than adding to it, so one changed row emits the
 *   whole set, and an unchanged table emits nothing;
 * - every value a person types is shell-quoted (`quoteShellArg`), so a path
 *   with spaces or a glob with `*` reaches `enroll` as one argument.
 *
 * `FLAG_CONTROLS` names the dialog control behind each exposed flag, which
 * `enrollFlags.spec.ts` checks against the flag table.
 */
import { ENROLL_FLAGS } from "$lib/enrollFlags";

export type CeilingAction = "allow" | "ask" | "deny";

export const CEILING_ACTIONS: readonly CeilingAction[] = ["allow", "ask", "deny"];

/** The rows of the ceiling table, in the order the dialog draws them. */
export const CEILING_KEYS = [
	"edit",
	"bash",
	"webfetch",
	"task",
	"session_spawn",
	"session_send",
	"session_read",
	"schedule",
] as const;
export type CeilingKey = (typeof CEILING_KEYS)[number];

/** What each row reads when the person touches nothing: `enroll`'s own default
 * ceiling (bash asks), everything else uncapped. */
export const DEFAULT_CEILING: Readonly<Record<CeilingKey, CeilingAction>> = {
	edit: "allow",
	bash: "ask",
	webfetch: "allow",
	task: "allow",
	session_spawn: "allow",
	session_send: "allow",
	session_read: "allow",
	schedule: "allow",
};

/** `enroll`'s own default for `--max-terminals`. */
export const DEFAULT_MAX_TERMINALS = 8;

/** Everything the dialog lets a person choose about the machine's policy. */
export interface EnrollPolicyChoices {
	allowTerminal: boolean;
	/** Only meaningful, and only emitted, when `allowTerminal` is on. */
	maxTerminals: number;
	ceiling: Record<CeilingKey, CeilingAction>;
	allowProjectConfig: boolean;
	allowCommandShell: boolean;
	allowBackgroundSubagents: boolean;
	noAgentTools: boolean;
	allowFreeModels: boolean;
	allowOpencodeProvider: boolean;
	workspaceRoots: string[];
	noFiles: boolean;
	fileDeny: string[];
	noDefaultFileDeny: boolean;
	/** `external_directory=allow`: no asking before work outside the workspace. */
	allowOutsideProject: boolean;
	/** `read=allow`: no asking before reading `.env` and similar files. */
	allowSecretReads: boolean;
}

export function defaultPolicyChoices(): EnrollPolicyChoices {
	return {
		allowTerminal: true,
		maxTerminals: DEFAULT_MAX_TERMINALS,
		ceiling: { ...DEFAULT_CEILING },
		allowProjectConfig: false,
		allowCommandShell: true,
		allowBackgroundSubagents: true,
		noAgentTools: false,
		allowFreeModels: false,
		allowOpencodeProvider: false,
		workspaceRoots: [],
		noFiles: false,
		fileDeny: [],
		noDefaultFileDeny: false,
		allowOutsideProject: false,
		allowSecretReads: false,
	};
}

/** The dialog control behind each exposed flag: its `data-testid`. */
export const FLAG_CONTROLS: Readonly<Record<string, string>> = {
	"no-terminal": "enroll-allow-terminal",
	"max-terminals": "enroll-max-terminals",
	"permission-max": "enroll-ceiling",
	"allow-project-config": "enroll-allow-project-config",
	"no-command-shell": "enroll-allow-command-shell",
	"no-background-subagents": "enroll-allow-background-subagents",
	"no-agent-tools": "enroll-no-agent-tools",
	"allow-free-models": "enroll-allow-free-models",
	"allow-opencode-provider": "enroll-allow-opencode-provider",
	"workspace-root": "enroll-workspace-roots",
	"no-files": "enroll-no-files",
	"file-deny": "enroll-file-deny",
	"no-default-file-deny": "enroll-no-default-file-deny",
	"permission-rule": "enroll-fixed-answers",
};

/** The flags the dialog has a control for, in the file's own terms. */
export function exposedFlags(): string[] {
	return ENROLL_FLAGS.filter((flag) => flag.exposed).map((flag) => flag.flag);
}

/** POSIX single-quoting: closes the quote, appends a literal single quote via
 * `'"'"'`, reopens it. Every value a person types goes through it. */
export function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** The ceiling differs from `enroll`'s own default in at least one row. */
export function ceilingChanged(ceiling: Record<CeilingKey, CeilingAction>): boolean {
	return CEILING_KEYS.some((key) => ceiling[key] !== DEFAULT_CEILING[key]);
}

/** The one action every row of the ceiling holds, or null when they differ
 * (enroll's own default is bash asking, the rest allowing).
 * The dialog's "All tools" row shows it and sets every row at once. */
export function uniformCeiling(ceiling: Record<CeilingKey, CeilingAction>): CeilingAction | null {
	const first = ceiling[CEILING_KEYS[0]];
	return CEILING_KEYS.every((key) => ceiling[key] === first) ? first : null;
}

/** `KEY=ACTION` pairs the ceiling flag carries. Empty while the table is as
 * `enroll` has it. Once any row differs, the flag states the WHOLE ceiling
 * (enroll replaces its default with the list), so every row that caps
 * something is named, and a row that `enroll` would have capped by default but
 * the person set to Allow is named too: `bash=allow` is how the owner opts
 * out, and leaving it out would silently bring the default back. */
export function ceilingPairs(ceiling: Record<CeilingKey, CeilingAction>): string[] {
	if (!ceilingChanged(ceiling)) return [];
	return CEILING_KEYS.filter(
		(key) => ceiling[key] !== "allow" || DEFAULT_CEILING[key] !== "allow"
	).map((key) => `${key}=${ceiling[key]}`);
}

/** Trimmed, non-empty values of a repeatable list. */
function listed(values: string[]): string[] {
	return values.map((value) => value.trim()).filter((value) => value !== "");
}

/** The permissions the two "without asking" checkboxes answer for the machine,
 * in the order the flags are printed. Both are allows: they restate, below the
 * agent's own rules, a name opencode would otherwise ask about. */
function fixedAnswers(choices: EnrollPolicyChoices): string[] {
	const names: string[] = [];
	if (choices.allowOutsideProject) names.push("external_directory");
	if (choices.allowSecretReads) names.push("read");
	return names;
}

/** `--max-terminals`'s value problem, or null. Whole numbers from 1. */
export function maxTerminalsProblem(value: number): string | null {
	return Number.isInteger(value) && value >= 1 ? null : "Use a whole number, 1 or more.";
}

/** The enroll flags the choices turn into, already shell-quoted, in a fixed
 * order. Defaults contribute nothing. */
export function policyFlagArgs(choices: EnrollPolicyChoices): string[] {
	const args: string[] = [];
	if (!choices.allowTerminal) {
		args.push("--no-terminal");
	} else if (
		maxTerminalsProblem(choices.maxTerminals) === null &&
		choices.maxTerminals !== DEFAULT_MAX_TERMINALS
	) {
		args.push("--max-terminals", String(choices.maxTerminals));
	}
	for (const pair of ceilingPairs(choices.ceiling)) args.push("--permission-max", pair);
	if (choices.allowProjectConfig) args.push("--allow-project-config");
	if (!choices.allowCommandShell) args.push("--no-command-shell");
	if (!choices.allowBackgroundSubagents) args.push("--no-background-subagents");
	if (choices.noAgentTools) args.push("--no-agent-tools");
	if (choices.allowFreeModels) args.push("--allow-free-models");
	if (choices.allowOpencodeProvider) args.push("--allow-opencode-provider");
	for (const root of listed(choices.workspaceRoots)) {
		args.push("--workspace-root", quoteShellArg(root));
	}
	if (choices.noFiles) args.push("--no-files");
	for (const glob of listed(choices.fileDeny)) args.push("--file-deny", quoteShellArg(glob));
	if (choices.noDefaultFileDeny) args.push("--no-default-file-deny");
	for (const rule of fixedAnswers(choices)) {
		args.push("--permission-rule", quoteShellArg(`${rule}=allow`));
	}
	return args;
}

/** How many controls differ from `enroll`'s default, for the Advanced
 * summary's count (the preview carries the values themselves). */
export function advancedChangedCount(choices: EnrollPolicyChoices): number {
	return [
		!choices.allowTerminal || choices.maxTerminals !== DEFAULT_MAX_TERMINALS,
		!choices.allowCommandShell,
		!choices.allowBackgroundSubagents,
		ceilingChanged(choices.ceiling) && uniformCeiling(choices.ceiling) === null,
		choices.noAgentTools,
		choices.allowFreeModels,
		choices.allowOpencodeProvider,
		listed(choices.workspaceRoots).length > 0,
		choices.noFiles,
		listed(choices.fileDeny).length > 0,
		choices.noDefaultFileDeny,
		choices.allowOutsideProject,
		choices.allowSecretReads,
	].filter(Boolean).length;
}

/** The `policy.json` fields `enroll` writes from these flags: what the dialog
 * promises. Compared (in `codeEnrollParity.spec.ts`) with the file a real
 * `galopin enroll` writes for the printed command. `opencodeProviders` is the
 * one promise that lands in `opencode.json` instead: whether its provider
 * allowlist is left out. */
export interface PromisedPolicy {
	permission: { max: Record<string, string>; rules: Record<string, string> };
	workspaceRoots: string[];
	allowFreeModels: boolean;
	files: "read" | "off";
	fileDeny: string[];
	noDefaultFileDeny: boolean;
	terminal: "allowed" | "denied";
	maxTerminals: number;
	commandShell: "allowed" | "denied";
	agentTools: "allowed" | "denied";
	projectConfig: "allowed" | "denied";
	backgroundSubagents: "allowed" | "denied";
	opencodeBuiltinProviders: boolean;
}

export function promisedPolicy(choices: EnrollPolicyChoices): PromisedPolicy {
	const pairs = ceilingPairs(choices.ceiling);
	const max = Object.fromEntries(
		(pairs.length > 0
			? pairs
			: Object.entries(DEFAULT_CEILING)
					.filter(([, action]) => action !== "allow")
					.map(([key, action]) => `${key}=${action}`)
		).map((pair) => pair.split("=") as [string, string])
	);
	const allowed = (on: boolean) => (on ? "allowed" : "denied");
	const terminalCap =
		choices.allowTerminal && maxTerminalsProblem(choices.maxTerminals) === null
			? choices.maxTerminals
			: DEFAULT_MAX_TERMINALS;
	return {
		permission: {
			max,
			rules: Object.fromEntries(fixedAnswers(choices).map((name) => [name, "allow"])),
		},
		workspaceRoots: listed(choices.workspaceRoots),
		allowFreeModels: choices.allowFreeModels,
		files: choices.noFiles ? "off" : "read",
		fileDeny: listed(choices.fileDeny),
		noDefaultFileDeny: choices.noDefaultFileDeny,
		terminal: allowed(choices.allowTerminal),
		maxTerminals: terminalCap,
		commandShell: allowed(choices.allowCommandShell),
		agentTools: choices.noAgentTools ? "denied" : "allowed",
		projectConfig: allowed(choices.allowProjectConfig),
		backgroundSubagents: allowed(choices.allowBackgroundSubagents),
		opencodeBuiltinProviders: choices.allowOpencodeProvider,
	};
}
