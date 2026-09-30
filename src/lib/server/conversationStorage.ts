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

import { deleteConversationDeliverables } from "$lib/server/execution/deliverables";
import { deleteConversationAttachments } from "$lib/server/files/deleteConversationAttachments";
import { deleteDerived } from "$lib/server/knowledge/deleteDerived";
import { logger } from "$lib/server/logger";
import type { Conversation } from "$lib/types/Conversation";

/**
 * Delete the deliverables, the attachments and the indexed transcript of a
 * conversation, or of a set of them.
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
	]);
	// The first two log their own failures. This one does not, and it is the
	// privacy one; the daily orphan sweep retries what it leaves.
	const derived = results[2];
	if (derived.status === "rejected") {
		logger.error(
			{ err: derived.reason },
			"conversation_memory_delete_failed: the orphan sweep will retry"
		);
	}
}
