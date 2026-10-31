/**
 * Removing what a conversation's attachments left behind.
 *
 * `uploadFile` writes two GridFS entries per attached document — the bytes,
 * and (for anything extractable) the markdown `extractDocument` read out of
 * them — both tagged `metadata.conversation`. Nothing removed either when the
 * conversation was deleted. The conversation document went, the deliverables
 * went, and the PDF somebody attached stayed in the file store indefinitely.
 *
 * That is a privacy answer before it is a disk one: "delete this conversation"
 * that leaves the document readable in the database is the wrong answer to a
 * question somebody asked deliberately.
 *
 * Deletion is by `metadata.conversation` rather than by the `<convId>-<sha>`
 * filename prefix, because the prefix is not the only naming scheme in that
 * bucket — knowledge-base documents live there too under their own original
 * filenames, tagged with an owner instead. Matching on the metadata is exact;
 * matching on the filename would be a guess that one day deletes somebody's
 * knowledge base.
 */

import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { Conversation } from "$lib/types/Conversation";
import { releasePreviewOwners } from "$lib/server/office/previewStore";

/**
 * What `metadata.conversation` holds: a conversation's ObjectId, or the
 * nanoid of a legacy shared copy of one (see `legacyShares.ts`).
 */
export type OwnerTag = Conversation["_id"] | string;

/**
 * Delete every stored attachment — bytes and extracted text alike — belonging
 * to a conversation or set of conversations.
 *
 * `blobStore.delete()` removes the bytes *and* the index row; deleting only the
 * row would leave the bytes behind, which is the
 * same orphaning this function exists to end.
 */
export async function deleteConversationAttachments(
	conversationId: OwnerTag | OwnerTag[]
): Promise<void> {
	const ids = Array.isArray(conversationId) ? conversationId : [conversationId];
	if (ids.length === 0) return;

	const files = await collections.blobStore.find("files", {
		"metadata.conversation": { $in: ids.map((id) => id.toString()) },
	});

	// One failure must not strand the rest: a file whose chunks are already
	// gone should not keep the other nine attachments of the same conversation
	// alive. Each is logged with its id so a leak is findable afterwards.
	const { failed } = await collections.blobStore.deleteMany(
		"files",
		files.map((file) => file.id)
	);
	for (const { id, error } of failed) {
		logger.error(
			{ err: error, fileId: id.toString() },
			"failed to delete conversation attachment bytes"
		);
	}

	// The Office previews made from these files (`office/previewStore.ts`) are
	// derived from them and go with them — unless another conversation's file
	// has the same bytes and still uses the same preview. Best effort: the
	// orphan sweep drops owners whose source is gone.
	await releasePreviewOwners(
		"att",
		ids.map((id) => id.toString())
	).catch((err) =>
		logger.error({ err }, "failed to release office previews of deleted attachments")
	);
}
