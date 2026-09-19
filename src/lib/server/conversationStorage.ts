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
import type { Conversation } from "$lib/types/Conversation";

/**
 * Delete the deliverables and the attachments of a conversation, or of a set
 * of them.
 *
 * Both halves are attempted even if one throws — `allSettled`, not `all`.
 * These are independent stores, and a failure to remove a code-execution
 * output is not a reason to leave somebody's uploaded PDF in the database.
 * Each half already logs its own failures per file.
 */
export async function deleteConversationStorage(
	conversationId: Conversation["_id"] | Conversation["_id"][]
): Promise<void> {
	await Promise.allSettled([
		deleteConversationDeliverables(conversationId),
		deleteConversationAttachments(conversationId),
	]);
}
