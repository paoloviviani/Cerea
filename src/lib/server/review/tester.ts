/**
 * The save-time test (ADR 0107 section 2): "Test on the standard cases". Runs the fixture's cases
 * through the same path a live ask takes (the static list, then the decision call) with the
 * candidate model, threshold and instructions, using the administrator's own token.
 *
 * Gating rule: a case gates the save only when its expected outcome is unambiguous under any
 * reasonable instruction: ordinary development work must be allowed, and the dangerous kinds
 * (data destruction, credentials and exfiltration, rewriting published history, publishing and
 * deploying, opening the machine up, prompt injection) must come to the user. Cases that depend on
 * the instruction (system administration, the grey zone) are run and shown with `gating: false`:
 * a deployment that allows apt installs is not wrong, and the test must not force its hand.
 * The scores move with the instruction (trials, round 2), so the test, not a fixed floor, is the guard.
 */
import cases from "./standardCases.json";
import type { ReviewTestCase, ReviewTestReport, ReviewTester } from "$lib/server/agentReview";
import { askDecisionModel } from "./call";
import type { AskFields } from "./frame";
import { staticEscalateReason } from "./static";

interface StandardCase {
	id: string;
	label: string;
	expected: "allow" | "escalate";
	gating: boolean;
	set: string;
	fields: AskFields;
}
export const STANDARD_CASES = cases.cases as StandardCase[];

const PARALLEL = 4;

export function makeReviewTester(call: typeof askDecisionModel = askDecisionModel): ReviewTester {
	return async ({ decisionModelId, threshold, instructions, token }) => {
		const out: Array<ReviewTestCase & { gating: boolean }> = [];
		const queue = [...STANDARD_CASES];
		async function worker() {
			for (let c = queue.shift(); c; c = queue.shift()) {
				out.push(await runCase(c));
			}
		}
		async function runCase(c: StandardCase): Promise<ReviewTestCase & { gating: boolean }> {
			const base = { id: c.id, label: c.label, expected: c.expected, gating: c.gating };
			const target = c.fields.command ?? c.fields.path ?? "";
			if (staticEscalateReason({ tool: c.fields.tool, targets: [target] })) {
				return { ...base, got: "escalate", probability: null, ok: c.expected === "escalate" };
			}
			if (!token) return { ...base, got: "error", probability: null, ok: false };
			const r = await call({ token, modelId: decisionModelId, instructions, fields: c.fields });
			if (!r.ok) return { ...base, got: "error", probability: null, ok: false };
			const got = r.probability >= threshold ? "allow" : "escalate";
			return { ...base, got, probability: r.probability, ok: got === c.expected };
		}
		await Promise.all(Array.from({ length: PARALLEL }, worker));
		const order = new Map(STANDARD_CASES.map((c, i) => [c.id, i]));
		out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
		const report: ReviewTestReport = {
			passed: out.every((c) => !c.gating || c.ok),
			cases: out,
		};
		return report;
	};
}
