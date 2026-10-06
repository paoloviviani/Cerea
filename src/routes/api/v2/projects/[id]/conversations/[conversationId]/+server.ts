/**
 * Take one conversation out of a project, back to the ordinary chat list.
 *
 * Exactly what deleting the project does to each of its chats: `projectId`
 * is cleared and the conversation's transcript leaves the project's memory
 * (`deleteDerived`), so a chat that is no longer in the project stops
 * surfacing in its retrieval. The conversation itself, its messages and its
 * files are untouched.
 *
 * Allowed to the conversation's own author, and to the project's owner — who
 * may tidy a shared workspace, and the chat then lands in its author's own
 * list, not theirs. Another member cannot remove a chat they did not start.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { deleteDerived } from "$lib/server/knowledge/deleteDerived";
import { requireProjectAccess } from "$lib/server/projects";

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const { project, owned, user } = await requireProjectAccess(locals, params.id);
	if (!params.conversationId || !ObjectId.isValid(params.conversationId)) {
		error(404, "No such conversation in this project.");
	}
	const conversation = await collections.conversations.findOne(
		{ _id: new ObjectId(params.conversationId), projectId: project._id },
		{ projection: { userId: 1 } }
	);
	if (!conversation) error(404, "No such conversation in this project.");
	const theirs = conversation.userId?.equals(user._id) === true;
	if (!theirs && !owned) {
		error(403, "Only the person who started a chat, or the project's owner, can remove it.");
	}
	await collections.conversations.updateOne(
		{ _id: conversation._id },
		{ $unset: { projectId: "" } }
	);
	await deleteDerived({ conversationId: conversation._id }).catch((err) =>
		logger.warn(
			{ err, conversationId: conversation._id },
			"project_detach_transcript_cleanup_failed"
		)
	);
	return new Response(null, { status: 204 });
};
