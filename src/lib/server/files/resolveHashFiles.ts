import type { Conversation } from "$lib/types/Conversation";
import type { MessageFile } from "$lib/types/Message";
import { logger } from "$lib/server/logger";
import { downloadFile } from "./downloadFile";
import { isExtractableDocument } from "./extractDocument";
import { uploadFile } from "./uploadFile";

/**
 * Files the browser sends back by reference (`{type: "hash"}`) on a retry, an
 * edit or a resend, rebuilt from what the server already knows about them.
 *
 * The browser's reference carries a name, a type and a hash, and none of what
 * the upload recorded: the extracted text, why extraction failed, a scan's page
 * images. Stored as sent, the message held a document the model was told "no
 * text could be read, and the reason was not recorded" about, while its text
 * sat in the bucket under the earlier message (seen live: a turn stopped and
 * sent again).
 *
 * So each reference takes the record of the same bytes from this
 * conversation's own messages; the browser's word is used for the name only.
 * A document nobody recorded anything for (its upload was cut short) is read
 * again from the stored bytes, once, now.
 */
export async function resolveHashFiles(
	refs: MessageFile[],
	conv: Conversation,
	token: string | undefined
): Promise<MessageFile[]> {
	if (refs.length === 0) return refs;
	const known = new Map<string, MessageFile>();
	for (const message of conv.messages) {
		for (const file of message.files ?? []) {
			if (file.type !== "hash") continue;
			const previous = known.get(file.value);
			// The richest record wins: one that says what extraction found.
			if (!previous || (!recorded(previous) && recorded(file))) known.set(file.value, file);
		}
	}

	return Promise.all(
		refs.map(async (ref) => {
			const record = known.get(ref.value);
			if (record && recorded(record)) {
				return { ...record, name: ref.name };
			}
			if (!isExtractableDocument(record?.mime ?? ref.mime)) return record ?? ref;
			try {
				const bytes = await downloadFile(ref.value, conv._id);
				const file = new File([Buffer.from(bytes.value, "base64")], ref.name, {
					type: bytes.mime || ref.mime,
				});
				logger.info(
					{ name: ref.name, sha: ref.value },
					"attachment_reextracted: a resent document had no extraction on record"
				);
				return await uploadFile(file, conv, token, { pageImages: true });
			} catch (err) {
				logger.warn({ err, sha: ref.value }, "attachment_reextract_failed");
				return record ?? ref;
			}
		})
	);
}

function recorded(file: MessageFile): boolean {
	return Boolean(file.extracted || file.extractionError || file.pageImages);
}
