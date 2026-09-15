import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { submitCodeExecutionResult } from "$lib/server/generation/codeExecution";
import { sweepParkedCalls } from "$lib/server/generation/parkedSweeper";
import { logger } from "$lib/server/logger";
import { error, json } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";

const bodySchema = z.object({
	executionId: z.string().uuid(),
	outcome: z.object({
		ok: z.boolean(),
		stdout: z.string(),
		stderr: z.string(),
		result: z.string().optional(),
		error: z.string().optional(),
		files: z
			.array(z.object({ path: z.string(), size: z.number() }))
			.max(200)
			.default([]),
	}),
});

/**
 * The browser posts the outcome of the code it ran in its own sandbox here.
 * Separate from the generation stream for the same reason answering an
 * elicitation is: by now no run is holding the turn at all, and the pod that
 * parked it need not be this one. Recording the outcome follows the wake
 * pattern (see wakeParkedCallEarly): the deadline move makes the resume
 * durable, and the ordinary sweep claim decides which pod resumes.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");

	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const conversationId = new ObjectId(params.id);

	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, ...authCondition(locals) },
		{ projection: { _id: 1 } }
	);
	if (!conversation) error(404, "Conversation not found");

	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Invalid code execution outcome");

	const result = await submitCodeExecutionResult({
		executionId: parsed.data.executionId,
		conversationId,
		outcome: parsed.data.outcome,
	});

	if (!result.ok) error(result.status, result.error);

	// Not awaited: the sweep runs the resumed turn to completion — minutes of
	// work, not a request's worth. The deadline move above is what makes the
	// wake durable; this only spares the person the sweep interval (same as the
	// early-wake endpoint for timers).
	void sweepParkedCalls().catch((err) =>
		logger.error({ err }, "[execute_code] the sweep kicked by the outcome post failed")
	);

	// A parked call resumes on a fresh run; the sweep that continues it runs to
	// completion, so it is never awaited here.
	return json({ ok: true, resume: result.resume, messageId: result.messageId });
};
