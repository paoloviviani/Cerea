import { describe, expect, it } from "vitest";
import type { Policy } from "$lib/types/machineProtocol";
import { PER_CLASS_DEFAULTS } from "$lib/types/AgentReview";
import { classRows, expectationLine, thirdStepLabel } from "./autoApproval";

const policy = (over: Partial<Policy> = {}): Policy => ({
	workspaceRoots: [],
	allowFreeModels: false,
	...over,
});
const reviewer = { reviewerAvailable: true, perClass: PER_CLASS_DEFAULTS };
const outcomes = (p: Policy | undefined, setup = reviewer) =>
	Object.fromEntries(classRows(p, setup).rows.map((r) => [r.class, r.outcome]));

describe("the third step's label", () => {
	it("is Auto only with a reviewer available and the device not opted out", () => {
		expect(thirdStepLabel(reviewer)).toBe("auto");
		expect(thirdStepLabel({ ...reviewer, reviewerAvailable: false })).toBe("allow");
		expect(thirdStepLabel({ ...reviewer, neverReview: true })).toBe("allow");
		expect(thirdStepLabel(null)).toBe("allow");
	});
});

describe("the computed line", () => {
	const defaults = policy({
		limits: {
			edit: "allow",
			web: "allow",
			tools: "allow",
			agents: "allow",
			command: "ask",
			outside: "ask",
			secrets: "ask",
			loop: "ask",
		},
	});

	it("for a default machine: edits, web, agents and tools run; commands and outside are reviewed; secrets and loops come to you", () => {
		expect(outcomes(defaults)).toMatchObject({
			edit: "run",
			web: "run",
			agents: "run",
			tools: "run",
			command: "reviewed",
			outside: "reviewed",
			secrets: "you",
			loop: "you",
		});
		const line = expectationLine("studio-laptop", classRows(defaults, reviewer).rows, "auto");
		expect(line).toBe(
			"Auto on studio-laptop: edits, web, agents and tools run · commands and outside access are reviewed · secrets and loops come to you"
		);
	});

	it("for a hands-off machine (commands=run): commands run, nothing is reviewed but outside", () => {
		const open = policy({ limits: { ...defaults.limits, command: "allow" } });
		expect(outcomes(open).command).toBe("run");
		expect(expectationLine("lab", classRows(open, reviewer).rows, "auto")).toBe(
			"Auto on lab: edits, commands, web, agents and tools run · outside access are reviewed · secrets and loops come to you"
		);
	});

	it("a never limit is refused and a loop stop ends the turn, whatever the rows say", () => {
		const strict = policy({ limits: { command: "deny", loop: "stop", secrets: "deny" } });
		expect(outcomes(strict)).toMatchObject({ command: "never", loop: "stop", secrets: "never" });
	});

	it("without a reviewer, or with the device opted out, every ask comes to you", () => {
		expect(outcomes(defaults, { ...reviewer, reviewerAvailable: false }).command).toBe("you");
		expect(outcomes(defaults, { ...reviewer, neverReview: true }).command).toBe("you");
		const line = expectationLine(
			"m",
			classRows(defaults, { ...reviewer, reviewerAvailable: false }).rows,
			"allow"
		);
		expect(line.startsWith("Allow on m:")).toBe(true);
		expect(line).not.toContain("reviewed");
	});

	it("follows the admin's row: a class set to you comes to you even with a reviewer", () => {
		const rows = { ...PER_CLASS_DEFAULTS, command: "you" as const };
		expect(outcomes(defaults, { reviewerAvailable: true, perClass: rows }).command).toBe("you");
	});

	it("for an older machine derives the default ceiling: commands and outside ask, the rest run", () => {
		const { older, rows } = classRows(policy({ permission: { max: {} } }), reviewer);
		expect(older).toBe(true);
		expect(Object.fromEntries(rows.map((r) => [r.class, r.outcome]))).toMatchObject({
			edit: "run",
			command: "reviewed",
			outside: "reviewed",
			secrets: "you",
			web: "run",
		});
		expect(rows.find((r) => r.class === "edit")?.reason).toBe("older");
	});

	it("an older machine's own ceiling (bash=deny) is honoured", () => {
		expect(outcomes(policy({ permission: { max: { bash: "deny" } } })).command).toBe("never");
	});
});
