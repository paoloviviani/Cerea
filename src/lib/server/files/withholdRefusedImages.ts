import { collections } from "$lib/server/database";
import { routingRefusal } from "$lib/server/gatewayErrors";
import { logger } from "$lib/server/logger";
import type { Conversation } from "$lib/types/Conversation";
import type { Message, MessageFile, WithheldByPrivacy } from "$lib/types/Message";

/**
 * Mark one stored file withheld: on the stored bytes themselves (so every
 * reader refuses, `downloadFile` first) and on every `MessageFile` of the
 * conversation that carries those bytes. The same two places an extractor
 * refusal marks (`uploadFile`).
 */
export async function withholdStoredFile(
	conversationId: Conversation["_id"],
	sha: string,
	withheld: WithheldByPrivacy
): Promise<void> {
	await collections.blobStore.update(
		"files",
		{ filename: `${conversationId.toString()}-${sha}` },
		{
			$set: {
				"metadata.withheldRule": withheld.rule,
				...(withheld.pipeline ? { "metadata.withheldPipeline": withheld.pipeline } : {}),
			},
		}
	);
	const conversation = await collections.conversations.findOne(
		{ _id: conversationId },
		{ projection: { messages: 1 } }
	);
	const set: Record<string, WithheldByPrivacy> = {};
	conversation?.messages.forEach((message, i) =>
		message.files?.forEach((file, j) => {
			if (file.type === "hash" && file.value === sha && !file.withheld) {
				set[`messages.${i}.files.${j}.withheld`] = withheld;
			}
		})
	);
	if (Object.keys(set).length > 0) {
		await collections.conversations.updateOne({ _id: conversationId }, { $set: set });
	}
}

/** The files of a request that went to the model as pictures: images, and a scan's page images. */
function sentAsPictures(files: MessageFile[]): MessageFile[] {
	return files.filter(
		(file) =>
			file.type === "hash" && !file.withheld && (file.mime.startsWith("image/") || file.pageImages)
	);
}

/**
 * When the gateway refused a chat request under a privacy rule, withhold the
 * images that request carried for vision.
 *
 * The refusal names the rule but not what tripped it (the gateway never
 * quotes content or file names), so it cannot say which image caused it: every
 * image of the request is withheld. That is the safe side: the request itself
 * could not proceed, and an image that is withheld stays listed to its owner
 * but is never mounted into the sandbox or read by a tool. A refusal for the
 * request's text withholds the images too; the cost of that is a visible chip.
 *
 * Returns the files marked. Never throws: marking is best effort and must not
 * hide the refusal the user is about to be shown.
 */
export async function withholdRefusedImages(
	conversationId: Conversation["_id"],
	sent: Message[],
	err: unknown,
	readsImages: boolean
): Promise<MessageFile[]> {
	const refusal = routingRefusal(err);
	if (!refusal || !readsImages) return [];
	const targets = new Map<string, MessageFile>();
	for (const message of sent) {
		for (const file of sentAsPictures(message.files ?? [])) {
			if (file.type === "hash") targets.set(file.value, file);
		}
	}
	try {
		for (const file of targets.values()) {
			if (file.type !== "hash") continue;
			await withholdStoredFile(conversationId, file.value, refusal);
			// A scan's page pictures are bytes the model saw too.
			for (const page of file.pageImages?.files ?? []) {
				await collections.blobStore.update(
					"files",
					{ filename: `${conversationId.toString()}-${page.value}` },
					{
						$set: {
							"metadata.withheldRule": refusal.rule,
							...(refusal.pipeline ? { "metadata.withheldPipeline": refusal.pipeline } : {}),
						},
					}
				);
			}
		}
	} catch (markErr) {
		logger.error({ err: String(markErr) }, "withhold_refused_images: could not mark the images");
	}
	logger.warn(
		{ rule: refusal.rule, pipeline: refusal.pipeline, files: targets.size },
		"image_withheld: a privacy rule refused a request with images; all its images are withheld"
	);
	return [...targets.values()];
}
