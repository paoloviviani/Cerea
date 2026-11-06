/**
 * "Test on the standard cases" (ADR 0109): runs the trial cases against the candidate model,
 * threshold and instructions with the caller's own token and shows the result. It records nothing
 * and gates nothing: a failing report never stops a save.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { normalize, reviewTester } from "$lib/server/agentReview";
import { INSTRUCTIONS_MAX, THRESHOLD_MAX, THRESHOLD_MIN } from "$lib/types/AgentReview";

const body = z.object({
	decisionModelId: z.string().trim().min(1).max(200),
	threshold: z.number().min(THRESHOLD_MIN).max(THRESHOLD_MAX),
	instructions: z.string().max(INSTRUCTIONS_MAX),
});

export const POST: RequestHandler = async ({ locals, request }) => {
	await requireCodeAgents(locals);
	const run = reviewTester();
	if (!run) error(501, "The standard-case test is not available here.");
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Send { decisionModelId, threshold, instructions }.");
	const candidate = normalize({ ...parsed.data, instructions: parsed.data.instructions.trim() });
	return json(
		await run({
			decisionModelId: parsed.data.decisionModelId,
			threshold: candidate.threshold,
			instructions: candidate.instructions,
			token: locals.token,
		})
	);
};
