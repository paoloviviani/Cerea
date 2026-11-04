import { describe, expect, it } from "vitest";
import { makeReviewTester, STANDARD_CASES } from "./tester";
import type { DecisionResult } from "./call";

/** A fake model that scores like the trials: routine high, everything else low. */
const fakeModel = (score: (cmd: string) => number): never =>
	(async ({
		fields,
	}: {
		fields: { command?: string; path?: string };
	}): Promise<DecisionResult> => ({
		ok: true,
		probability: score(fields.command ?? fields.path ?? ""),
	})) as never;

const ROUTINE =
	/^(ls |go test|npm test|git status|git add -A && git commit|npx prettier|npm install --save-dev)|\/src\//;
const candidate = { decisionModelId: "m", threshold: 0.9, instructions: "", token: "t" };

describe("the standard cases", () => {
	it("cover both trial rounds and every case has an unambiguous gating flag", () => {
		const sets = new Set(STANDARD_CASES.map((c) => c.set));
		expect(sets).toEqual(new Set(["round1", "grey", "sysadmin"]));
		expect(
			STANDARD_CASES.filter((c) => c.gating && c.expected === "allow").length
		).toBeGreaterThanOrEqual(6);
		expect(
			STANDARD_CASES.filter((c) => c.gating && c.expected === "escalate").length
		).toBeGreaterThanOrEqual(20);
		expect(new Set(STANDARD_CASES.map((c) => c.id)).size).toBe(STANDARD_CASES.length);
	});
});

describe("the save-time test", () => {
	it("passes a reviewer that allows routine work and escalates the rest", async () => {
		const run = makeReviewTester(fakeModel((c) => (ROUTINE.test(c) ? 0.95 : 0.05)));
		const report = await run(candidate);
		expect(report.cases).toHaveLength(STANDARD_CASES.length);
		expect(report.passed).toBe(true);
		const apt = report.cases.find((c) => c.id === "r2-apt");
		expect(apt).toMatchObject({ got: "escalate", expected: "allow", ok: false, gating: false });
	});

	it("fails when a must-escalate case gets through", async () => {
		const run = makeReviewTester(fakeModel(() => 0.99));
		const report = await run(candidate);
		expect(report.passed).toBe(false);
		const bad = report.cases.filter((c) => c.gating && !c.ok).map((c) => c.id);
		expect(bad).toContain("r1-force-push");
		expect(bad).toContain("r1-injection-title");
	});

	it("fails when a routine case is escalated", async () => {
		const run = makeReviewTester(fakeModel(() => 0.2));
		const report = await run(candidate);
		expect(report.passed).toBe(false);
		expect(report.cases.find((c) => c.id === "r1-npm-test")).toMatchObject({
			got: "escalate",
			ok: false,
		});
	});

	it("an informational miss does not fail it, a gating miss does", async () => {
		// the sysadmin instruction allows apt, which the default would not: still a pass
		const ok = makeReviewTester(
			fakeModel((c) => (ROUTINE.test(c) || /apt-get|systemctl/.test(c) ? 0.95 : 0.05))
		);
		expect((await ok(candidate)).passed).toBe(true);
	});

	it("a failing call is an error case: it fails a gating case", async () => {
		const run = makeReviewTester((async () => ({
			ok: false,
			kind: "unreachable",
			detail: "x",
		})) as never);
		const report = await run(candidate);
		expect(report.passed).toBe(false);
		expect(report.cases.some((c) => c.got === "error")).toBe(true);
	});

	it("rule-escalated cases never reach the model", async () => {
		let calls = 0;
		const run = makeReviewTester((async () => {
			calls += 1;
			return { ok: true, probability: 0.05 };
		}) as never);
		const report = await run(candidate);
		const policy = report.cases.find((c) => c.id === "r1-galopin-policy");
		expect(policy).toMatchObject({ got: "escalate", probability: null, ok: true });
		expect(calls).toBeLessThan(STANDARD_CASES.length);
	});
});
