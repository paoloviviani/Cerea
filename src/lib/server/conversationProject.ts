/**
 * Moving a conversation into, between and out of projects.
 *
 * One operation, `moveConversationToProject`, behind `PATCH
 * /api/v2/conversations/[id]` (`{ projectId: string | null }`). The project
 * page's "Remove from project" (`DELETE .../projects/[id]/conversations/[cid]`)
 * calls `detachConversation` here, so the two cannot drift.
 *
 * Rules:
 * - into a project, or between projects: the caller must be the conversation's
 *   author and have access to the target project (`requireProjectAccess`);
 * - out: the author, or the owner of the project the chat is in (who may tidy
 *   a shared workspace; the chat then lands in its author's own list);
 * - leaving a project always drops the transcript from its memory
 *   (`deleteDerived`); entering one indexes the whole existing thread the way
 *   a finished turn would (`indexConversation` is whole-thread and idempotent by
 *   handle, so there is nothing to backfill per message). Indexing is not
 *   awaited: an embedding call is not worth a slow menu click, and the function
 *   logs its own failures.
 * - project instructions, documents and memory are read from `projectId` on
 *   every turn, so they apply from the next message and history is untouched.
 */

import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { deleteDerived } from "$lib/server/knowledge/deleteDerived";
import { indexConversation, requireProjectAccess } from "$lib/server/projects";
import { convertLegacyConversation } from "$lib/utils/tree/convertLegacyConversation";
import type { Conversation } from "$lib/types/Conversation";

/** Clear `projectId` and drop the transcript from the project's memory. */
export async function detachConversation(conversationId: Conversation["_id"]): Promise<void> {
	await collections.conversations.updateOne(
		{ _id: conversationId },
		{ $unset: { projectId: "" } }
	);
	await deleteDerived({ conversationId }).catch((err) =>
		logger.warn({ err, conversationId }, "project_detach_transcript_cleanup_failed")
	);
}

export interface MoveResult {
	/** The project the chat is in now, or null. */
	projectId: string | null;
	/** Its name, for a confirmation. */
	projectName: string | null;
}

export async function moveConversationToProject(options: {
	locals: App.Locals;
	conversationId: string;
	/** A project id, or null to take it out of its project. */
	projectId: string | null;
}): Promise<MoveResult> {
	const { locals, conversationId, projectId } = options;
	if (!locals.user) error(401, "Login required");
	if (!ObjectId.isValid(conversationId)) error(400, "Invalid conversation ID");
	if (projectId !== null && (typeof projectId !== "string" || !ObjectId.isValid(projectId))) {
		error(400, "projectId must be a project id or null");
	}
	const conversation = await collections.conversations.findOne({
		_id: new ObjectId(conversationId),
	});
	if (!conversation) error(404, "Conversation not found");
	const theirs = conversation.userId?.equals(locals.user._id) === true;
	const current = conversation.projectId;

	if (projectId === null) {
		if (!current) return { projectId: null, projectName: null };
		if (!theirs) {
			const owned = await collections.projects.countDocuments(
				{ _id: current, userId: locals.user._id },
				{ limit: 1 }
			);
			if (owned === 0) error(404, "Conversation not found");
		}
		await detachConversation(conversation._id);
		return { projectId: null, projectName: null };
	}

	// Moving in is the author's alone; someone else's chat looks like a missing one.
	if (!theirs) error(404, "Conversation not found");
	const { project } = await requireProjectAccess(locals, projectId);
	if (current?.equals(project._id)) {
		return { projectId: project._id.toString(), projectName: project.name };
	}

	await collections.conversations.updateOne(
		{ _id: conversation._id },
		{ $set: { projectId: project._id } }
	);
	if (current) {
		await deleteDerived({ conversationId: conversation._id }).catch((err) =>
			logger.warn(
				{ err, conversationId: conversation._id },
				"project_move_transcript_cleanup_failed"
			)
		);
	}
	const moved = {
		...conversation,
		...convertLegacyConversation(conversation),
		projectId: project._id,
	};
	void indexConversation({
		project,
		conversation: moved,
		messages: moved.messages,
		token: locals.token,
		locals,
	}).catch((err) => logger.warn({ err }, "project_memory_index_failed: unexpected rejection"));
	return { projectId: project._id.toString(), projectName: project.name };
}
