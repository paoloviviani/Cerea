import { describe, expect, it } from "vitest";
import {
	CEILING_KEYS,
	DEFAULT_CEILING,
	advancedChangedCount,
	ceilingChanged,
	ceilingPairs,
	defaultPolicyChoices,
	maxTerminalsProblem,
	policyFlagArgs,
	promisedPolicy,
	quoteShellArg,
	ruleKeyProblem,
	type EnrollPolicyChoices,
} from "./codeEnrollPolicy";
import { buildEnrollCommand } from "./codeEnrollCommand";

const choose = (over: Partial<EnrollPolicyChoices>): EnrollPolicyChoices => ({
	...defaultPolicyChoices(),
	...over,
});
const flags = (over: Partial<EnrollPolicyChoices>) => policyFlagArgs(choose(over));

describe("defaults emit nothing", () => {
	it("an untouched dialog adds no policy flag at all", () => {
		expect(policyFlagArgs(defaultPolicyChoices())).toEqual([]);
	});

	it("the command is the plain enroll one, byte for byte", () => {
		const base = {
			origin: "https://cerea.example.org/chat",
			issuer: "https://idp.example.org",
			gatewayOrigin: "https://gateway.example.org",
		};
		expect(buildEnrollCommand({ ...base, ...defaultPolicyChoices() })).toBe(
			buildEnrollCommand(base)
		);
	});

	it("its default ceiling is enroll's own: bash and session_spawn ask, the rest uncapped", () => {
		expect(DEFAULT_CEILING).toEqual({
			edit: "allow",
			bash: "ask",
			webfetch: "allow",
			task: "allow",
			session_spawn: "ask",
			session_send: "allow",
		});
		expect([...CEILING_KEYS]).toEqual([
			"edit",
			"bash",
			"webfetch",
			"task",
			"session_spawn",
			"session_send",
		]);
	});

	it("the machine the defaults promise is the one a plain enroll writes", () => {
		expect(promisedPolicy(defaultPolicyChoices())).toEqual({
			permission: { max: { bash: "ask", session_spawn: "ask" }, rules: {} },
			workspaceRoots: [],
			allowFreeModels: false,
			files: "read",
			fileDeny: [],
			noDefaultFileDeny: false,
			terminal: "denied",
			maxTerminals: 8,
			commandShell: "denied",
			agentTools: "allowed",
			projectConfig: "denied",
			backgroundSubagents: "denied",
			opencodeBuiltinProviders: false,
		});
	});
});

describe("each control emits exactly its flag", () => {
	const cases: Array<[string, Partial<EnrollPolicyChoices>, string[]]> = [
		["terminal", { allowTerminal: true }, ["--allow-terminal"]],
		["trust repos", { allowProjectConfig: true }, ["--allow-project-config"]],
		["command shell", { allowCommandShell: true }, ["--allow-command-shell"]],
		["background subagents", { allowBackgroundSubagents: true }, ["--allow-background-subagents"]],
		["no agent tools", { noAgentTools: true }, ["--no-agent-tools"]],
		["free models", { allowFreeModels: true }, ["--allow-free-models"]],
		["opencode provider", { allowOpencodeProvider: true }, ["--allow-opencode-provider"]],
		["no files", { noFiles: true }, ["--no-files"]],
		["no default file deny", { noDefaultFileDeny: true }, ["--no-default-file-deny"]],
		["a workspace root", { workspaceRoots: ["/srv/work"] }, ["--workspace-root", "'/srv/work'"]],
		["a file deny glob", { fileDeny: ["*.secret"] }, ["--file-deny", "'*.secret'"]],
		[
			"a machine rule",
			{ permissionRules: [{ key: "edit", action: "ask" }] },
			["--permission-rule", "'edit=ask'"],
		],
	];
	for (const [label, over, expected] of cases) {
		it(`${label}`, () => {
			expect(flags(over)).toEqual(expected);
		});
	}

	it("max terminals: a number only with the terminal box ticked, only when not 8", () => {
		expect(flags({ allowTerminal: true, maxTerminals: 3 })).toEqual([
			"--allow-terminal",
			"--max-terminals",
			"3",
		]);
		expect(flags({ allowTerminal: true, maxTerminals: 8 })).toEqual(["--allow-terminal"]);
		// A number left behind in a hidden field is not a flag.
		expect(flags({ allowTerminal: false, maxTerminals: 3 })).toEqual([]);
	});

	it("max terminals: an unusable number emits nothing rather than a refused enroll", () => {
		for (const bad of [0, -1, 2.5, Number.NaN]) {
			expect(flags({ allowTerminal: true, maxTerminals: bad })).toEqual(["--allow-terminal"]);
			expect(maxTerminalsProblem(bad)).not.toBeNull();
		}
		expect(maxTerminalsProblem(1)).toBeNull();
	});

	it("repeatable lists emit one flag per entry, in order, skipping blanks", () => {
		expect(flags({ workspaceRoots: ["/a", "  ", "/b"], fileDeny: ["", "x*", "y"] })).toEqual([
			"--workspace-root",
			"'/a'",
			"--workspace-root",
			"'/b'",
			"--file-deny",
			"'x*'",
			"--file-deny",
			"'y'",
		]);
		expect(flags({ permissionRules: [{ key: " ", action: "ask" }] })).toEqual([]);
	});

	it("machine rules emit in the order given, each with its own action", () => {
		expect(
			flags({
				permissionRules: [
					{ key: "edit", action: "ask" },
					{ key: "webfetch", action: "deny" },
					{ key: "bash", action: "allow" },
				],
			})
		).toEqual([
			"--permission-rule",
			"'edit=ask'",
			"--permission-rule",
			"'webfetch=deny'",
			"--permission-rule",
			"'bash=allow'",
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
			permissionRules: [{ key: "edit", action: "ask" }],
			ceiling: { ...DEFAULT_CEILING, edit: "ask" },
		});
		expect(policyFlagArgs(everything).join(" ")).not.toContain("auto-accept");
	});
});

describe("the ceiling table", () => {
	it("an unchanged table emits nothing", () => {
		expect(ceilingChanged({ ...DEFAULT_CEILING })).toBe(false);
		expect(ceilingPairs({ ...DEFAULT_CEILING })).toEqual([]);
		expect(flags({ ceiling: { ...DEFAULT_CEILING } })).toEqual([]);
	});

	it("one changed row emits the FULL set, defaults included", () => {
		const ceiling = { ...DEFAULT_CEILING, edit: "ask" as const };
		expect(ceilingChanged(ceiling)).toBe(true);
		expect(ceilingPairs(ceiling)).toEqual(["edit=ask", "bash=ask", "session_spawn=ask"]);
		expect(flags({ ceiling })).toEqual([
			"--permission-max",
			"edit=ask",
			"--permission-max",
			"bash=ask",
			"--permission-max",
			"session_spawn=ask",
		]);
	});

	it("a default row set to Allow is named explicitly: that is how an owner opts out", () => {
		const ceiling = { ...DEFAULT_CEILING, bash: "allow" as const };
		expect(ceilingPairs(ceiling)).toEqual(["bash=allow", "session_spawn=ask"]);
	});

	it("every row Allow still emits something, so the default does not come back", () => {
		const allOpen = Object.fromEntries(CEILING_KEYS.map((key) => [key, "allow"])) as Record<
			(typeof CEILING_KEYS)[number],
			"allow"
		>;
		expect(ceilingPairs(allOpen)).toEqual(["bash=allow", "session_spawn=allow"]);
	});

	it("a Deny row is carried as deny", () => {
		expect(ceilingPairs({ ...DEFAULT_CEILING, webfetch: "deny" })).toEqual([
			"bash=ask",
			"webfetch=deny",
			"session_spawn=ask",
		]);
	});

	it("moving a row away and back leaves the table unchanged: nothing emitted", () => {
		const ceiling = { ...DEFAULT_CEILING };
		ceiling.edit = "deny";
		ceiling.edit = "allow";
		expect(ceilingPairs(ceiling)).toEqual([]);
	});

	it("promises the ceiling the flags write, and the default when nothing is emitted", () => {
		expect(
			promisedPolicy(choose({ ceiling: { ...DEFAULT_CEILING, bash: "allow" } })).permission.max
		).toEqual({ bash: "allow", session_spawn: "ask" });
		expect(
			promisedPolicy(choose({ ceiling: { ...DEFAULT_CEILING, edit: "deny" } })).permission.max
		).toEqual({ edit: "deny", bash: "ask", session_spawn: "ask" });
	});
});

describe("quoting", () => {
	it("a path with spaces reaches enroll as one argument", () => {
		expect(flags({ workspaceRoots: ["/home/me/my projects"] })).toEqual([
			"--workspace-root",
			"'/home/me/my projects'",
		]);
	});

	it("a glob is quoted so the shell cannot expand it", () => {
		expect(flags({ fileDeny: ["*.pem", "config/prod?.yml", "[a-z]*"] })).toEqual([
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
		expect(command).toContain("--workspace-root '/home/me/my projects' --file-deny '*.secret'");
	});

	it("trims stray spaces around a typed value, not inside it", () => {
		expect(flags({ workspaceRoots: ["  /a b  "] })).toEqual(["--workspace-root", "'/a b'"]);
	});
});

describe("machine rules' key", () => {
	it("flags a pattern or a pasted KEY=ACTION, and passes a plain key", () => {
		expect(ruleKeyProblem("bash")).toBeNull();
		expect(ruleKeyProblem("")).toBeNull();
		expect(ruleKeyProblem("ba*")).not.toBeNull();
		expect(ruleKeyProblem("bash=ask")).not.toBeNull();
	});
});

describe("the Advanced summary's count", () => {
	it("counts what differs among the Advanced controls, not the common ones", () => {
		expect(advancedChangedCount(defaultPolicyChoices())).toBe(0);
		expect(advancedChangedCount(choose({ allowTerminal: true, allowProjectConfig: true }))).toBe(0);
		expect(
			advancedChangedCount(
				choose({ allowCommandShell: true, workspaceRoots: ["/a", "/b"], noFiles: true })
			)
		).toBe(3);
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
				fileDeny: ["*.x"],
				noDefaultFileDeny: true,
				permissionRules: [{ key: "edit", action: "ask" }],
			})
		);
		expect(promised).toEqual({
			permission: { max: { bash: "ask", session_spawn: "ask" }, rules: { edit: "ask" } },
			workspaceRoots: ["/a b"],
			allowFreeModels: true,
			files: "off",
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
