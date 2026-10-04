/**
 * Everything a conversation stored outside its own document, removed together.
 *
 * There are four routes that delete conversations — two singular, two bulk,
 * across the v1 and v2 APIs — and each used to call the deliverables cleanup
 * directly. That worked for as long as deliverables were the only thing a
 * conversation left behind, and stopped being true when attachments arrived:
 * the files were never deleted anywhere, and adding the call to four places
 * would have set the same trap for the fifth route somebody writes next.
 *
 * So the routes call this, and this knows the list. Adding another kind of
 * stored thing means adding it here, once.
 */

import { collections } from "$lib/server/database";
import { deleteConversationDeliverables } from "$lib/server/execution/deliverables";
import { deleteConversationAttachments } from "$lib/server/files/deleteConversationAttachments";
import { deleteDerived } from "$lib/server/knowledge/deleteDerived";
import { logger } from "$lib/server/logger";
import type { Conversation } from "$lib/types/Conversation";

/**
 * The share links made from these conversations, and the files copied for
 * them (`routes/conversation/[id]/share`, which copies the attachments under
 * the share's own id). A link is a snapshot, but it is the conversation's
 * snapshot: "delete this conversation" that leaves a public link serving it
 * is the wrong answer to a deliberate question. The rows go first, so the
 * link is dead whatever happens to the files; the sweep retries those.
 * Shares are found by `conversationId`, which new ones carry and legacy ones
 * get at boot (`backfillSharedConversationIds`).
 */
export async function deleteConversationShares(
	conversationId: Conversation["_id"] | Conversation["_id"][]
): Promise<void> {
	const ids = Array.isArray(conversationId) ? conversationId : [conversationId];
	if (ids.length === 0) return;
	const shares = await collections.sharedConversations
		.find({ conversationId: { $in: ids } })
		.project<{ _id: string }>({ _id: 1 })
		.toArray();
	if (shares.length === 0) return;
	const shareIds = shares.map((share) => share._id);
	await collections.sharedConversations.deleteMany({ _id: { $in: shareIds } });
	await deleteConversationAttachments(shareIds);
}

/**
 * Delete the deliverables, the attachments, the share links and the indexed
 * transcript of a conversation, or of a set of them.
 *
 * The transcript is the project's memory of it: `indexConversation` writes
 * `chat:conversation:<id>` into the project's memory base, and every later
 * turn searches it. Left behind, a deleted conversation stays retrievable.
 * It is found by handle in *any* base, because the base that holds it is
 * whichever the project pointed at when it was written. All four delete
 * routes come through here (the v1 bulk route, unlike v2's, does not exclude
 * project conversations), so this is the one place that has to know.
 *
 * A constraint for the route nobody has written yet: moving a conversation
 * *out of* a project (there is none today, `projectId` is set once at
 * creation) must call `deleteDerived({ conversationId })` too, or the
 * transcript stays in the project's memory and keeps surfacing in a
 * project the conversation no longer belongs to.
 *
 * Both halves are attempted even if one throws — `allSettled`, not `all`.
 * These are independent stores, and a failure to remove a code-execution
 * output is not a reason to leave somebody's uploaded PDF in the database.
 * Each half already logs its own failures per file.
 */
export async function deleteConversationStorage(
	conversationId: Conversation["_id"] | Conversation["_id"][]
): Promise<void> {
	const results = await Promise.allSettled([
		deleteConversationDeliverables(conversationId),
		deleteConversationAttachments(conversationId),
		deleteDerived({ conversationId }),
		deleteConversationShares(conversationId),
	]);
	// The first two log their own failures. These do not, and they are the
	// privacy ones; the daily orphan sweep retries what they leave.
	const derived = results[2];
	const shares = results[3];
	if (shares.status === "rejected") {
		logger.error(
			{ err: shares.reason },
			"conversation_share_delete_failed: the orphan sweep will retry"
		);
	}
	if (derived.status === "rejected") {
		logger.error(
			{ err: derived.reason },
			"conversation_memory_delete_failed: the orphan sweep will retry"
		);
	}
}
