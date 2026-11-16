/**
 * Archiving a conversation: hide it from the lists without deleting it.
 *
 * Behind `PATCH /api/v2/conversations/[id]` (`{ archived: boolean }`).
 *
 * - Only the chat's author (`authCondition`: its user, or its anonymous session) may archive or unarchive it, in a shared project
 *   too; anyone else gets 404 (a missing chat and someone else's look alike).
 * - Archiving a project chat takes it out of the project, the way "Remove from
 *   project" does (`detachConversation`: `projectId` cleared, the transcript
 *   dropped from the project's memory). Unarchiving does not put it back: it
 *   returns as a normal chat.
 * - Sending a message in an archived chat unarchives it (the send route).
 * - Schedules that target an archived chat keep running; nothing here touches them.
 */

import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { detachConversation } from "$lib/server/conversationProject";

export interface ArchiveResult {
	archivedAt: Date | null;
	/** The chat was in a project and has been taken out of it. */
	leftProject: boolean;
}

export async function setConversationArchived(options: {
	locals: App.Locals;
	conversationId: string;
	archived: boolean;
}): Promise<ArchiveResult> {
	const { locals, conversationId, archived } = options;
	if (typeof archived !== "boolean") error(400, "archived must be a boolean");
	if (!ObjectId.isValid(conversationId)) error(400, "Invalid conversation ID");
	const _id = new ObjectId(conversationId);
	const conversation = await collections.conversations.findOne(
		{ _id, ...authCondition(locals) },
		{ projection: { projectId: 1, archivedAt: 1 } }
	);
	if (!conversation) error(404, "Conversation not found");

	if (!archived) {
		await collections.conversations.updateOne({ _id }, { $unset: { archivedAt: "" } });
		return { archivedAt: null, leftProject: false };
	}

	const archivedAt = conversation.archivedAt ?? new Date();
	await collections.conversations.updateOne({ _id }, { $set: { archivedAt } });
	const leftProject = !!conversation.projectId;
	if (leftProject) await detachConversation(_id);
	return { archivedAt, leftProject };
}
