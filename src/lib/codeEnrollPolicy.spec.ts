import { describe, expect, it } from "vitest";
import {
	DEFAULT_LIMITS,
	LIMIT_CLASSES,
	advancedChangedCount,
	allowedLimits,
	changedLimits,
	defaultPolicyChoices,
	limitPairs,
	maxTerminalsProblem,
	policyFlagArgs,
	promisedPolicy,
	quoteShellArg,
	type EnrollPolicyChoices,
} from "./codeEnrollPolicy";
import { buildEnrollCommand } from "./codeEnrollCommand";

const choose = (over: Partial<EnrollPolicyChoices>): EnrollPolicyChoices => ({
	...defaultPolicyChoices(),
	...over,
});
// Every choice set starts from the dialog's own defaults, and the dialog now
// opens with the billing box ticked: the expected arrays below carry its
// --default-group first (its default is pinned in "the dialog's defaults"
// and "billing to the console default").
const flags = (over: Partial<EnrollPolicyChoices>) => policyFlagArgs(choose(over));

describe("the dialog's defaults", () => {
	it("an untouched dialog adds exactly one policy flag: --default-group, the one default the dialog deliberately does not share with enroll", () => {
		expect(policyFlagArgs(defaultPolicyChoices())).toEqual(["--default-group"]);
	});

	it("the default choices are exactly what the command already prints, byte for byte", () => {
		const base = {
			origin: "https://cerea.example.org/chat",
			issuer: "https://idp.example.org",
			gatewayOrigin: "https://gateway.example.org",
		};
		expect(buildEnrollCommand({ ...base, ...defaultPolicyChoices() })).toBe(
			buildEnrollCommand(base)
		);
	});

	it("its default limits are the machine's own (ADR 0107): commands, outside and secrets ask, the rest run", () => {
		expect(DEFAULT_LIMITS).toEqual({
			edit: "run",
			command: "ask",
			web: "run",
			outside: "ask",
			secrets: "ask",
			agents: "run",
			tools: "run",
			loop: "ask",
		});
		expect([...LIMIT_CLASSES]).toEqual([
			"edit",
			"command",
			"web",
			"outside",
			"secrets",
			"agents",
			"tools",
			"loop",
		]);
	});

	it("secrets offers never and ask only, loop offers ask and stop", () => {
		expect(allowedLimits("secrets")).toEqual(["never", "ask"]);
		expect(allowedLimits("loop")).toEqual(["ask", "stop"]);
		expect(allowedLimits("command")).toEqual(["never", "ask", "run"]);
	});

	it("the machine the defaults promise is the one a plain enroll writes", () => {
		expect(promisedPolicy(defaultPolicyChoices())).toEqual({
			limits: DEFAULT_LIMITS,
			workspaceRoots: [],
			allowFreeModels: false,
			files: "read",
			fileWrite: "allowed",
			fileDeny: [],
			noDefaultFileDeny: false,
			terminal: "allowed",
			maxTerminals: 8,
			commandShell: "allowed",
			agentTools: "allowed",
			projectConfig: "denied",
			backgroundSubagents: "allowed",
			opencodeBuiltinProviders: false,
		});
	});
});

describe("each control emits exactly its flag", () => {
	const cases: Array<[string, Partial<EnrollPolicyChoices>, string[]]> = [
		["terminal off", { allowTerminal: false }, ["--default-group", "--no-terminal"]],
		["trust repos", { allowProjectConfig: true }, ["--default-group", "--allow-project-config"]],
		["command shell off", { allowCommandShell: false }, ["--default-group", "--no-command-shell"]],
		[
			"background subagents off",
			{ allowBackgroundSubagents: false },
			["--default-group", "--no-background-subagents"],
		],
		["no agent tools", { noAgentTools: true }, ["--default-group", "--no-agent-tools"]],
		["free models", { allowFreeModels: true }, ["--default-group", "--allow-free-models"]],
		[
			"opencode provider",
			{ allowOpencodeProvider: true },
			["--default-group", "--allow-opencode-provider"],
		],
		["no files", { noFiles: true }, ["--default-group", "--no-files"]],
		["file writes", { allowFileWrite: true }, ["--default-group", "--allow-file-write"]],
		[
			"file writes with files off",
			{ noFiles: true, allowFileWrite: true },
			["--default-group", "--no-files"],
		],
		[
			"no default file deny",
			{ noDefaultFileDeny: true },
			["--default-group", "--no-default-file-deny"],
		],
		[
			"a workspace root",
			{ workspaceRoots: ["/srv/work"] },
			["--default-group", "--workspace-root", "'/srv/work'"],
		],
		[
			"a file deny glob",
			{ fileDeny: ["*.secret"] },
			["--default-group", "--file-deny", "'*.secret'"],
		],
		["bill to the console default", { billToDefault: true }, ["--default-group"]],
	];
	for (const [label, over, expected] of cases) {
		it(`${label}`, () => {
			expect(flags(over)).toEqual(expected);
		});
	}

	it("max terminals: a number only with terminals on, only when not 8", () => {
		expect(flags({ allowTerminal: true, maxTerminals: 3 })).toEqual([
			"--default-group",
			"--max-terminals",
			"3",
		]);
		expect(flags({ allowTerminal: true, maxTerminals: 8 })).toEqual(["--default-group"]);
		// A number left behind in a hidden field is not a flag.
		expect(flags({ allowTerminal: false, maxTerminals: 3 })).toEqual([
			"--default-group",
			"--no-terminal",
		]);
	});

	it("max terminals: an unusable number emits nothing rather than a refused enroll", () => {
		for (const bad of [0, -1, 2.5, Number.NaN]) {
			expect(flags({ allowTerminal: true, maxTerminals: bad })).toEqual(["--default-group"]);
			expect(maxTerminalsProblem(bad)).not.toBeNull();
		}
		expect(maxTerminalsProblem(1)).toBeNull();
	});

	it("repeatable lists emit one flag per entry, in order, skipping blanks", () => {
		expect(flags({ workspaceRoots: ["/a", "  ", "/b"], fileDeny: ["", "x*", "y"] })).toEqual([
			"--default-group",
			"--workspace-root",
			"'/a'",
			"--workspace-root",
			"'/b'",
			"--file-deny",
			"'x*'",
			"--file-deny",
			"'y'",
		]);
	});

	it("never emits --allow-auto-accept, whatever else is set", () => {
		const everything = choose({
			allowTerminal: true,
			allowProjectConfig: true,
			allowCommandShell: true,
			allowBackgroundSubagents: true,
			noAgentTools: true,
			allowFreeModels: true,
			allowOpencodeProvider: true,
			noFiles: true,
			noDefaultFileDeny: true,
			workspaceRoots: ["/a"],
			fileDeny: ["x"],
			billToDefault: true,
			limits: { ...DEFAULT_LIMITS, edit: "ask" },
		});
		expect(policyFlagArgs(everything).join(" ")).not.toContain("auto-accept");
	});
});

describe("billing to the console default", () => {
	it("the dialog's default: the generated command carries --default-group, never --group beside it", () => {
		// Element equality, not substring: a future group picker must not
		// print the two ways of naming billing together (enroll refuses the
		// pair) -- and "--default-group" itself is not "--group", so the
		// string check below means what it says.
		const args = policyFlagArgs(defaultPolicyChoices());
		expect(args).toContain("--default-group");
		expect(args).not.toContain("--group");
		expect(
			buildEnrollCommand({
				origin: "https://cerea.example.org/chat",
				issuer: "https://idp.example.org",
				gatewayOrigin: "https://gateway.example.org",
			})
		).toContain("--default-group");
	});

	it("never next to --group: the two ways of naming billing contradict each other", () => {
		// The dialog has no group picker today, so this pins the shape rather
		// than a live bug: whichever control grows one, the two flags must
		// never print together (enroll refuses the pair). Element equality,
		// not substring: "--default-group" contains "--group".
		const everything = choose({
			billToDefault: true,
			allowTerminal: false,
			workspaceRoots: ["/a"],
			limits: { ...DEFAULT_LIMITS, edit: "ask" },
		});
		expect(policyFlagArgs(everything)).toContain("--default-group");
		expect(policyFlagArgs(everything)).not.toContain("--group");
	});

	it("counts in the Advanced badge, when unticked: ticked is the dialog's own default", () => {
		expect(advancedChangedCount(choose({ billToDefault: false }))).toBe(1);
		expect(advancedChangedCount(choose({ billToDefault: true }))).toBe(0);
	});
});

describe("the limits table", () => {
	it("an unchanged table emits nothing (the billing default aside)", () => {
		expect(changedLimits({ ...DEFAULT_LIMITS })).toEqual([]);
		expect(limitPairs({ ...DEFAULT_LIMITS })).toEqual([]);
		expect(flags({ limits: { ...DEFAULT_LIMITS } })).toEqual(["--default-group"]);
	});

	it("one changed class emits exactly one --limit, and no old alias flag", () => {
		const limits = { ...DEFAULT_LIMITS, edit: "ask" as const };
		expect(changedLimits(limits)).toEqual(["edit"]);
		expect(flags({ limits })).toEqual(["--default-group", "--limit", "edit=ask"]);
		expect(flags({ limits }).join(" ")).not.toContain("permission-");
	});

	it("opening commands names commands only: that is how an owner opts out of the default ask", () => {
		expect(limitPairs({ ...DEFAULT_LIMITS, command: "run" })).toEqual(["command=run"]);
	});

	it("carries each changed class, in the table's order, including never and stop", () => {
		expect(
			limitPairs({
				...DEFAULT_LIMITS,
				loop: "stop",
				web: "never",
				outside: "run",
				secrets: "never",
			})
		).toEqual(["web=never", "outside=run", "secrets=never", "loop=stop"]);
	});

	it("moving a class away and back leaves the table unchanged: nothing emitted", () => {
		const limits = { ...DEFAULT_LIMITS };
		limits.edit = "never";
		limits.edit = "run";
		expect(limitPairs(limits)).toEqual([]);
	});

	it("promises the whole table, defaults filled in", () => {
		expect(
			promisedPolicy(choose({ limits: { ...DEFAULT_LIMITS, command: "run" } })).limits
		).toEqual({ ...DEFAULT_LIMITS, command: "run" });
		expect(promisedPolicy(defaultPolicyChoices()).limits).toEqual(DEFAULT_LIMITS);
	});
});

describe("quoting", () => {
	it("a path with spaces reaches enroll as one argument", () => {
		expect(flags({ workspaceRoots: ["/home/me/my projects"] })).toEqual([
			"--default-group",
			"--workspace-root",
			"'/home/me/my projects'",
		]);
	});

	it("a glob is quoted so the shell cannot expand it", () => {
		expect(flags({ fileDeny: ["*.pem", "config/prod?.yml", "[a-z]*"] })).toEqual([
			"--default-group",
			"--file-deny",
			"'*.pem'",
			"--file-deny",
			"'config/prod?.yml'",
			"--file-deny",
			"'[a-z]*'",
		]);
	});

	it("an embedded single quote, a dollar and a backtick stay inert", () => {
		expect(quoteShellArg("it's")).toBe(`'it'"'"'s'`);
		expect(flags({ workspaceRoots: ["/a/$(rm -rf ~)/`x`"] })).toEqual([
			"--default-group",
			"--workspace-root",
			"'/a/$(rm -rf ~)/`x`'",
		]);
	});

	it("quotes inside the whole printed command too, spaces and all", () => {
		const command = buildEnrollCommand({
			origin: "https://cerea.example.org",
			issuer: "https://idp.example.org",
			gatewayOrigin: "https://gateway.example.org",
			...choose({ workspaceRoots: ["/home/me/my projects"], fileDeny: ["*.secret"] }),
		});
		expect(command).toContain(
			"  --workspace-root '/home/me/my projects' \\\n  --file-deny '*.secret'"
		);
	});

	it("trims stray spaces around a typed value, not inside it", () => {
		expect(flags({ workspaceRoots: ["  /a b  "] })).toEqual([
			"--default-group",
			"--workspace-root",
			"'/a b'",
		]);
	});
});

describe("the Advanced summary's count", () => {
	it("counts what differs among the Advanced controls, not the common ones", () => {
		expect(advancedChangedCount(defaultPolicyChoices())).toBe(0);
		expect(advancedChangedCount(choose({ allowTerminal: true, allowProjectConfig: true }))).toBe(0);
		expect(
			advancedChangedCount(
				choose({ allowCommandShell: false, workspaceRoots: ["/a", "/b"], noFiles: true })
			)
		).toBe(3);
		// Saving files counts while files are on; with files off it emits nothing.
		expect(advancedChangedCount(choose({ allowFileWrite: true }))).toBe(1);
		expect(advancedChangedCount(choose({ allowFileWrite: true, noFiles: true }))).toBe(1);
		// Terminals, the command shell and background subagents count when turned off.
		expect(
			advancedChangedCount(
				choose({ allowTerminal: false, allowCommandShell: false, allowBackgroundSubagents: false })
			)
		).toBe(3);
		// Commands sit among the common options; every other class counts under Advanced.
		expect(advancedChangedCount(choose({ limits: { ...DEFAULT_LIMITS, command: "run" } }))).toBe(0);
		expect(advancedChangedCount(choose({ limits: { ...DEFAULT_LIMITS, web: "never" } }))).toBe(1);
	});

	it("a blank list entry does not count", () => {
		expect(advancedChangedCount(choose({ workspaceRoots: [" "], fileDeny: [""] }))).toBe(0);
	});
});

describe("the promised policy.json", () => {
	it("follows every flag the dialog can print", () => {
		const promised = promisedPolicy(
			choose({
				allowTerminal: true,
				maxTerminals: 3,
				allowProjectConfig: true,
				allowCommandShell: true,
				allowBackgroundSubagents: true,
				noAgentTools: true,
				allowFreeModels: true,
				allowOpencodeProvider: true,
				workspaceRoots: ["/a b"],
				noFiles: true,
				allowFileWrite: true,
				fileDeny: ["*.x"],
				noDefaultFileDeny: true,
			})
		);
		expect(promised).toEqual({
			limits: DEFAULT_LIMITS,
			workspaceRoots: ["/a b"],
			allowFreeModels: true,
			files: "off",
			// Asked for, but there is nothing to save from with files off.
			fileWrite: "denied",
			fileDeny: ["*.x"],
			noDefaultFileDeny: true,
			terminal: "allowed",
			maxTerminals: 3,
			commandShell: "allowed",
			agentTools: "denied",
			projectConfig: "allowed",
			backgroundSubagents: "allowed",
			opencodeBuiltinProviders: true,
		});
	});
});
