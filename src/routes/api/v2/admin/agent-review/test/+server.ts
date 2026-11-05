/**
 * "Test on the standard cases": runs the trial cases against the candidate model, threshold and
 * instructions. The runner is the review service's (`registerReviewTester`); until it is registered
 * this answers 501 and the settings save is not gated on a test.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireAdmin } from "$lib/server/admin";
import {
	normalize,
	recordPassingTest,
	reviewTester,
	settingsFingerprint,
} from "$lib/server/agentReview";
import { INSTRUCTIONS_MAX, THRESHOLD_MAX, THRESHOLD_MIN } from "$lib/types/AgentReview";

const body = z.object({
	decisionModelId: z.string().trim().min(1).max(200),
	threshold: z.number().min(THRESHOLD_MIN).max(THRESHOLD_MAX),
	instructions: z.string().max(INSTRUCTIONS_MAX),
});

export const POST: RequestHandler = async ({ locals, request }) => {
	await requireAdmin(locals);
	const run = reviewTester();
	if (!run) error(501, "The standard-case test is not available yet.");
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Send { decisionModelId, threshold, instructions }.");
	const candidate = normalize({ ...parsed.data, instructions: parsed.data.instructions.trim() });
	const report = await run({
		decisionModelId: parsed.data.decisionModelId,
		threshold: candidate.threshold,
		instructions: candidate.instructions,
		token: locals.token,
	});
	if (report.passed) await recordPassingTest(settingsFingerprint(candidate));
	return json(report);
};
