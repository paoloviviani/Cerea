/**
 * Removing what a conversation's attachments left behind.
 *
 * `uploadFile` writes two GridFS entries per attached document — the bytes,
 * and (for anything extractable) the markdown `extractDocument` read out of
 * them — both tagged `metadata.conversation`. Nothing removed either when the
 * conversation was deleted. The conversation document went, the deliverables
 * went, and the PDF somebody attached stayed in `files.chunks` indefinitely.
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

import { ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { Conversation } from "$lib/types/Conversation";

/**
 * What `metadata.conversation` holds: a conversation's ObjectId, or the
 * nanoid of a shared copy of one (`routes/conversation/[id]/share`).
 */
export type OwnerTag = Conversation["_id"] | string;

/**
 * Delete every stored attachment — bytes and extracted text alike — belonging
 * to a conversation or set of conversations.
 *
 * `bucket.delete()` removes the file document *and* its chunks; a bare
 * `deleteMany` on `files.files` would leave the chunks behind, which is the
 * same orphaning this function exists to end.
 */
export async function deleteConversationAttachments(
	conversationId: OwnerTag | OwnerTag[]
): Promise<void> {
	const ids = Array.isArray(conversationId) ? conversationId : [conversationId];
	if (ids.length === 0) return;

	const files = await collections.bucket
		.find({ "metadata.conversation": { $in: ids.map((id) => id.toString()) } })
		.project<{ _id: ObjectId }>({ _id: 1 })
		.toArray();

	// One failure must not strand the rest: a file whose chunks are already
	// gone should not keep the other nine attachments of the same conversation
	// alive. Each is logged with its id so a leak is findable afterwards.
	await Promise.all(
		files.map((file) =>
			collections.bucket
				.delete(file._id)
				.catch((err) =>
					logger.error(
						{ err, fileId: file._id.toString() },
						"failed to delete conversation attachment bytes"
					)
				)
		)
	);
}
