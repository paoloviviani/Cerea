import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENROLL_FLAGS } from "./enrollFlags";
import {
	FLAG_CONTROLS,
	defaultPolicyChoices,
	exposedFlags,
	policyFlagArgs,
} from "./codeEnrollPolicy";

/**
 * The dialog and `galopin enroll` must not drift: every flag enroll has is
 * classified, every exposed one has a control, and the defaults emit nothing.
 *
 * `agent/packaging/enroll-flags.json` is the agent half's own classification
 * (a Go test there fails when `enroll` gains a flag it does not list). Until
 * that file lands on this branch, the TypeScript copy is checked against the
 * flags `enroll.go` registers; once it lands, against the file itself.
 */
const AGENT_DIR = fileURLToPath(new URL("../../agent/", import.meta.url));
const JSON_PATH = `${AGENT_DIR}packaging/enroll-flags.json`;

describe("enrollFlags (the TypeScript copy)", () => {
	it("every exposed flag has a dialog control, and every control is for an exposed flag", () => {
		expect(Object.keys(FLAG_CONTROLS).sort()).toEqual(exposedFlags().sort());
	});

	it("no flag is listed twice", () => {
		const names = ENROLL_FLAGS.map((flag) => flag.flag);
		expect(new Set(names).size).toBe(names.length);
	});

	it("`--allow-auto-accept` is gone from the table and from every control", () => {
		expect(ENROLL_FLAGS.map((flag) => flag.flag)).not.toContain("allow-auto-accept");
		expect(Object.keys(FLAG_CONTROLS)).not.toContain("allow-auto-accept");
	});

	it("the connection plumbing is deliberately not exposed", () => {
		const hidden = ENROLL_FLAGS.filter((flag) => !flag.exposed).map((flag) => flag.flag);
		for (const plumbing of [
			"cerea",
			"client-id",
			"creds",
			"device",
			"discover",
			"gateway",
			"group",
			"issuer",
			"loopback",
			"output",
			"shim-port",
			"yes",
		]) {
			expect(hidden, plumbing).toContain(plumbing);
		}
	});

	it("an exposed flag's default is what the empty dialog emits: nothing", () => {
		expect(policyFlagArgs(defaultPolicyChoices())).toEqual([]);
		// And every flag the dialog can print is a known, exposed one.
		const everything = policyFlagArgs({
			...defaultPolicyChoices(),
			allowTerminal: true,
			maxTerminals: 2,
			allowProjectConfig: true,
			allowCommandShell: true,
			allowBackgroundSubagents: true,
			noAgentTools: true,
			allowFreeModels: true,
			allowOpencodeProvider: true,
			workspaceRoots: ["/a"],
			noFiles: true,
			fileDeny: ["x"],
			noDefaultFileDeny: true,
			permissionRules: [{ key: "edit", action: "ask" }],
			ceiling: { ...defaultPolicyChoices().ceiling, edit: "ask" },
		})
			.filter((arg) => arg.startsWith("--"))
			.map((arg) => arg.slice(2));
		expect([...new Set(everything)].sort()).toEqual(exposedFlags().sort());
	});
});

describe("against the agent", () => {
	it("matches the flags `enroll` registers (enroll.go), each classified exactly once", () => {
		const source = readFileSync(`${AGENT_DIR}enroll.go`, "utf8");
		const registered = [
			...source.matchAll(/fs\.(?:StringVar|BoolVar|IntVar|Var|Bool|String|Int)\([^"]*"([a-z-]+)"/g),
		].map((match) => match[1]);
		// The retired flag still parses (it warns that it does nothing), so it
		// is registered but classified nowhere: it is not a policy any more.
		const policyRegistered = registered.filter((name) => name !== "allow-auto-accept").sort();
		expect(policyRegistered).toEqual(ENROLL_FLAGS.map((flag) => flag.flag).sort());
	});

	it.skipIf(!existsSync(JSON_PATH))(
		"equals agent/packaging/enroll-flags.json, flag for flag",
		() => {
			const agentFlags = JSON.parse(readFileSync(JSON_PATH, "utf8")) as Array<{
				flag: string;
				kind: string;
				default: unknown;
				exposed: boolean;
			}>;
			const byName = (list: Array<{ flag: string }>) =>
				Object.fromEntries(list.map((entry) => [entry.flag.replace(/^--/, ""), entry]));
			expect(Object.keys(byName(agentFlags)).sort()).toEqual(
				ENROLL_FLAGS.map((flag) => flag.flag).sort()
			);
			for (const flag of ENROLL_FLAGS) {
				const theirs = byName(agentFlags)[flag.flag] as (typeof agentFlags)[number];
				expect(theirs.exposed, `${flag.flag} exposed`).toBe(flag.exposed);
				expect(theirs.kind, `${flag.flag} kind`).toBe(flag.kind);
				expect(theirs.default, `${flag.flag} default`).toEqual(flag.default);
			}
		}
	);
});
