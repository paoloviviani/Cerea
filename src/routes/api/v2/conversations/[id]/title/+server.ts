import { error, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { saveGeneratedTitle } from "$lib/server/conversationSettings";
import { regenerateTitle } from "$lib/server/textGeneration/title";

/**
 * Regenerate a chat's title (the sidebar's "Regenerate title"). Owner only.
 * A title the user typed is never replaced: 409, whether it was typed before
 * the call or while the model was working.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	requireAuth(locals);

	const id = params.id ?? "";
	if (!ObjectId.isValid(id)) error(400, "Invalid conversation ID");
	const conv = await collections.conversations.findOne({
		_id: new ObjectId(id),
		...authCondition(locals),
	});
	if (!conv) error(404, "Conversation not found");

	const result = await regenerateTitle(conv, locals);
	if (!result.ok) {
		if (result.reason === "user-title") error(409, "You named this chat yourself.");
		if (result.reason === "no-messages") error(409, "There is nothing to title yet.");
		error(503, "A title could not be written. Try again.");
	}

	const saved = await saveGeneratedTitle(conv._id, {
		title: result.title,
		titleSource: "model",
		titleAttempts: conv.titleAttempts,
	});
	// Nothing matched: a rename landed while the model was working, and it is final.
	if (saved.matchedCount === 0) error(409, "You named this chat yourself.");

	return superjsonResponse({ title: result.title });
};
