import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { assertInternalRequest } from "$lib/server/internalAuth";
import { runErasure } from "$lib/server/identity/erasure";

/**
 * `POST /internal/erasure` (`/chat/internal/erasure` on the stack, ADR 0093
 * §9.3): the gateway's own call, after it has erased its own rows and
 * recorded a `pending` `chat_erasures` row — retried with backoff until this
 * answers 200. Idempotent: a repeat of the same `erasure_id` after `doneAt`
 * returns the recorded counts without doing anything again; a repeat after a
 * crash mid-run resumes from what `runErasure` persisted at the start.
 */
const bodySchema = z.object({
	erasure_id: z.string().min(1),
	gateway_user_id: z.string().min(1),
	identities: z.array(z.object({ issuer: z.string(), subject: z.string() })).default([]),
});

export const POST: RequestHandler = async ({ request }) => {
	assertInternalRequest(request);

	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Invalid erasure request");

	const result = await runErasure(
		parsed.data.erasure_id,
		parsed.data.gateway_user_id,
		parsed.data.identities
	);

	return json({ erasure_id: result.erasureId, counts: result.counts });
};
