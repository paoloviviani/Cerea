/**
 * The machine-policy half of the Pair-a-machine dialog: what a person can
 * choose, which `galopin enroll` flags that turns into, and the `policy.json`
 * the machine will then hold.
 *
 * Pure, so it has its own specs independent of rendering. Three rules it
 * keeps, each pinned in `codeEnrollPolicy.spec.ts`:
 *
 * - a default emits **nothing**: the printed command carries a flag only for
 *   a choice that differs from what `enroll` does on its own — with the one
 *   deliberate divergence below (`billToDefault`: the dialog ticks it, while
 *   `enroll` itself keeps requiring an explicit `--default-group`);
 * - there are no machine limits (ADR 0109): the dialog prints no `--limit`, and galopin ignores
 *   one if an old command is pasted;
 * - every value a person types is shell-quoted (`quoteShellArg`), so a path
 *   with spaces or a glob with `*` reaches `enroll` as one argument.
 *
 * `FLAG_CONTROLS` names the dialog control behind each exposed flag, which
 * `enrollFlags.spec.ts` checks against the flag table.
 */
import { m } from "$lib/paraglide/messages";
import { ENROLL_FLAGS } from "$lib/enrollFlags";

/** `enroll`'s own default for `--max-terminals`. */
export const DEFAULT_MAX_TERMINALS = 8;

/** Everything the dialog lets a person choose about the machine's policy. */
export interface EnrollPolicyChoices {
	allowTerminal: boolean;
	/** Only meaningful, and only emitted, when `allowTerminal` is on. */
	maxTerminals: number;
	allowProjectConfig: boolean;
	allowCommandShell: boolean;
	allowBackgroundSubagents: boolean;
	noAgentTools: boolean;
	allowFreeModels: boolean;
	allowOpencodeProvider: boolean;
	workspaceRoots: string[];
	noFiles: boolean;
	/** `--allow-file-write`: the /code editor may save files. Only emitted
	 * while files are on: with `--no-files` there is nothing to save from. */
	allowFileWrite: boolean;
	fileDeny: string[];
	noDefaultFileDeny: boolean;
	/** `--default-group`: bill to the person's default billing group — the one
	 * the Pystino console's group picker sets — instead of pinning a group for
	 * this machine. The dialog has no group picker to disable: whichever
	 * control grows one, the two ways of naming billing never print together
	 * (enroll refuses the pair). The dialog's default is **on** — a machine
	 * paired through the dialog follows the console default unless the person
	 * unticks it — while `enroll`'s own default stays off (the CLI keeps
	 * requiring an explicit `--default-group`; `enroll-flags.json` records
	 * that CLI default, and the Go drift test pins it). */
	billToDefault: boolean;
}

export function defaultPolicyChoices(): EnrollPolicyChoices {
	return {
		allowTerminal: true,
		maxTerminals: DEFAULT_MAX_TERMINALS,
		allowProjectConfig: false,
		allowCommandShell: true,
		allowBackgroundSubagents: true,
		noAgentTools: false,
		allowFreeModels: false,
		allowOpencodeProvider: false,
		workspaceRoots: [],
		noFiles: false,
		allowFileWrite: false,
		fileDeny: [],
		noDefaultFileDeny: false,
		billToDefault: true,
	};
}

/** The dialog control behind each exposed flag: its `data-testid`. */
export const FLAG_CONTROLS: Readonly<Record<string, string>> = {
	"no-terminal": "enroll-allow-terminal",
	"max-terminals": "enroll-max-terminals",
	"allow-project-config": "enroll-allow-project-config",
	"no-command-shell": "enroll-allow-command-shell",
	"no-background-subagents": "enroll-allow-background-subagents",
	"no-agent-tools": "enroll-no-agent-tools",
	"allow-free-models": "enroll-allow-free-models",
	"allow-opencode-provider": "enroll-allow-opencode-provider",
	"workspace-root": "enroll-workspace-roots",
	"no-files": "enroll-no-files",
	"allow-file-write": "enroll-allow-file-write",
	"file-deny": "enroll-file-deny",
	"no-default-file-deny": "enroll-no-default-file-deny",
	"default-group": "enroll-bill-to-default",
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

/** Trimmed, non-empty values of a repeatable list. */
function listed(values: string[]): string[] {
	return values.map((value) => value.trim()).filter((value) => value !== "");
}

/** `--max-terminals`'s value problem, or null. Whole numbers from 1. */
export function maxTerminalsProblem(value: number): string | null {
	return Number.isInteger(value) && value >= 1 ? null : m["code.enroll.whole_number"]();
}

/** The enroll flags the choices turn into, already shell-quoted, in a fixed
 * order. Defaults contribute nothing. */
export function policyFlagArgs(choices: EnrollPolicyChoices): string[] {
	const args: string[] = [];
	if (choices.billToDefault) {
		args.push("--default-group");
	}
	if (!choices.allowTerminal) {
		args.push("--no-terminal");
	} else if (
		maxTerminalsProblem(choices.maxTerminals) === null &&
		choices.maxTerminals !== DEFAULT_MAX_TERMINALS
	) {
		args.push("--max-terminals", String(choices.maxTerminals));
	}
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
	else if (choices.allowFileWrite) args.push("--allow-file-write");
	for (const glob of listed(choices.fileDeny)) args.push("--file-deny", quoteShellArg(glob));
	if (choices.noDefaultFileDeny) args.push("--no-default-file-deny");
	return args;
}

/** How many Advanced controls differ from the dialog's own opening state, for
 * the Advanced summary's count (the preview carries the values themselves).
 * For every control but billing that is also `enroll`'s default; the billing
 * box opens ticked, so unticking it is the change that counts. */
export function advancedChangedCount(choices: EnrollPolicyChoices): number {
	return [
		!choices.allowTerminal || choices.maxTerminals !== DEFAULT_MAX_TERMINALS,
		!choices.allowCommandShell,
		!choices.allowBackgroundSubagents,
		choices.noAgentTools,
		choices.allowFreeModels,
		choices.allowOpencodeProvider,
		listed(choices.workspaceRoots).length > 0,
		choices.noFiles,
		choices.allowFileWrite && !choices.noFiles,
		listed(choices.fileDeny).length > 0,
		choices.noDefaultFileDeny,
		!choices.billToDefault,
	].filter(Boolean).length;
}

/** The `policy.json` fields `enroll` writes from these flags: what the dialog
 * promises. Compared (in `codeEnrollParity.spec.ts`) with the file a real
 * `galopin enroll` writes for the printed command. `opencodeProviders` is the
 * one promise that lands in `opencode.json` instead: whether its provider
 * allowlist is left out. */
export interface PromisedPolicy {
	workspaceRoots: string[];
	allowFreeModels: boolean;
	files: "read" | "off";
	fileWrite: "allowed" | "denied";
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
	const allowed = (on: boolean) => (on ? "allowed" : "denied");
	const terminalCap =
		choices.allowTerminal && maxTerminalsProblem(choices.maxTerminals) === null
			? choices.maxTerminals
			: DEFAULT_MAX_TERMINALS;
	return {
		workspaceRoots: listed(choices.workspaceRoots),
		allowFreeModels: choices.allowFreeModels,
		files: choices.noFiles ? "off" : "read",
		// The file editor is on by default (ADR 0107): off only with files off.
		fileWrite: allowed(!choices.noFiles),
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
