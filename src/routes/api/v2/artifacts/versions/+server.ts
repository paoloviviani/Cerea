/**
 * "Delete older versions" of one artifact (C122), the owner's own chat only.
 *
 * POST { conversationId, identifier, leafMessageId? } keeps the artifact's current version
 * (on the branch the panel shows), deletes the older ones and answers with how many went and
 * how many stayed because an active share link points at them. Never content.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { deleteOlderVersions, PruneError } from "$lib/server/artifactVersions/prune";

const body = z.object({
	conversationId: z.string(),
	identifier: z.string().min(1).max(500),
	leafMessageId: z.string().min(1).max(200).optional(),
});

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user && !locals.sessionId) error(401, "Login required");
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success || !ObjectId.isValid(parsed.data.conversationId)) {
		error(400, "Say which artifact.");
	}
	try {
		const result = await deleteOlderVersions(
			{ userId: locals.user?._id, sessionId: locals.sessionId },
			{
				conversationId: new ObjectId(parsed.data.conversationId),
				identifier: parsed.data.identifier,
				leafMessageId: parsed.data.leafMessageId,
			}
		);
		return json(result);
	} catch (err) {
		if (err instanceof PruneError) error(err.status, err.message);
		throw err;
	}
};
