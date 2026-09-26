import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { assertInternalRequest } from "$lib/server/internalAuth";
import { previewErasure } from "$lib/server/identity/erasure";

/**
 * `POST /internal/erasure/preview` (`/chat/internal/erasure/preview` on the
 * stack, ADR 0093 §9.3): the gateway's delete-preview dialog calls this for
 * the chat's own dry-run counts, per collection — nothing is deleted.
 * `unattributed_legacy_shares` is a system-wide caveat, not a per-person
 * count: shares made before `SharedConversation.userId` existed that the
 * startup backfill could not attribute to anyone can never be tied to a
 * person by this or any later run, so the dialog surfaces it whenever any
 * exist rather than silently under-reporting this (or any) person's shares.
 */
const bodySchema = z.object({
	gateway_user_id: z.string().min(1),
	identities: z.array(z.object({ issuer: z.string(), subject: z.string() })).default([]),
});

export const POST: RequestHandler = async ({ request }) => {
	assertInternalRequest(request);

	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Invalid erasure preview request");

	const preview = await previewErasure(parsed.data.gateway_user_id, parsed.data.identities);

	return json({
		counts: preview.counts,
		unattributed_legacy_shares: preview.unattributedLegacyShares,
	});
};
