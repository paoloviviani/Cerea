import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { executionBackend } from "$lib/server/codeExecution/backend";
import { error, json } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";

const bodySchema = z.object({
	executionId: z.string().uuid(),
});

/**
 * The page tells the server a pending `execute_code` run is paused (the page
 * went to the background, or is coming back and restarting the run). The parked
 * call then keeps waiting for the longer paused window instead of expiring into
 * "execution environment unavailable" while the phone is locked.
 *
 * Sent with `navigator.sendBeacon` as the page hides, so it has to be a plain
 * POST with a JSON body and answers nothing the page needs. Ownership is the
 * conversation's (`authCondition`), and the call must be a pending `code` call
 * of that conversation: holding an id is no authority over anyone else's run.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");
	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const conversationId = new ObjectId(params.id);

	const backend = executionBackend();
	if (!backend.supportsPause) error(404, "Not found");

	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, ...authCondition(locals) },
		{ projection: { _id: 1 } }
	);
	if (!conversation) error(404, "Conversation not found");

	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Invalid pause signal");

	const result = await backend.pause(conversationId, parsed.data.executionId);
	if (!result.ok) error(result.status, result.error);
	return json({ ok: true, resumeAt: result.resumeAt.getTime() });
};
