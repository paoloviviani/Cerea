import type { Conversation } from "$lib/types/Conversation";
import type { MessageFile } from "$lib/types/Message";
import { sha256 } from "$lib/utils/sha256";
import { fileTypeFromBuffer } from "file-type";
import { collections } from "$lib/server/database";
import { extractDocument, isExtractableDocument } from "./extractDocument";

/** One GridFS entry, resolved when the write has actually landed. */
async function store(
	name: string,
	bytes: Buffer,
	metadata: Record<string, string | number>
): Promise<void> {
	const upload = collections.bucket.openUploadStream(name, { metadata });
	upload.write(bytes);
	upload.end();
	await new Promise<void>((resolve, reject) => {
		upload.once("finish", () => resolve());
		upload.once("error", reject);
		setTimeout(() => reject(new Error("Upload timed out")), 20_000);
	});
}

/**
 * Store one attachment, and — if it is a document — the text of it.
 *
 * The extraction happens here, at upload, and never again: `/v1/ocr` is priced
 * per page, so reading the same twelve-page PDF on every turn would charge for
 * it on every turn. The text goes in beside the bytes as its own entry, named
 * on the returned `MessageFile`.
 *
 * A failed extraction does **not** fail the upload. The attachment is stored
 * either way and simply carries no text, which the prompt then says out loud —
 * losing somebody's file because its text could not be read is the worse of
 * the two outcomes, and `extractDocument` logs which reason it was.
 */
export async function uploadFile(
	file: File,
	conv: Conversation,
	token?: string
): Promise<MessageFile> {
	return writeAttachment(file, conv._id.toString(), token);
}

/**
 * What an owner-keyed entry carries beyond chat's `{conversation, mime}`: the
 * message it was sent with, and enough of the `MessageFile` to rebuild it
 * from the bucket alone (`attachmentStore.findAttachments`). The extracted-text
 * entry names the bytes it was read out of, so a lookup can pair the two.
 */
export interface AttachmentTag {
	messageId: string;
}

/**
 * What `uploadFile` does, for any owner key rather than only a conversation
 * id — the one writer both chat and the owner-keyed store
 * (`attachmentStore.ts`) go through, so a file sent to an agent is stored,
 * named and extracted exactly as a file sent to a chat is.
 *
 * Chat passes no `tag`, so a conversation's entries stay `{conversation,
 * mime}`, byte for byte.
 */
export async function writeAttachment(
	file: File,
	ownerKey: string,
	token?: string,
	tag?: AttachmentTag
): Promise<MessageFile> {
	const buffer = await file.arrayBuffer();
	const sha = await sha256(await file.text());

	// Attempt to detect the mime type of the file, fallback to the uploaded mime
	const mime = await fileTypeFromBuffer(buffer).then((fileType) => fileType?.mime ?? file.type);

	await store(`${ownerKey}-${sha}`, Buffer.from(buffer), {
		conversation: ownerKey,
		mime,
		...(tag ? { messageId: tag.messageId, sha, name: file.name, declaredMime: file.type } : {}),
	});

	const stored: MessageFile = { type: "hash", value: sha, mime: file.type, name: file.name };
	if (!isExtractableDocument(mime)) return stored;

	const extracted = await extractDocument({ bytes: buffer, mime, filename: file.name, token });
	// A failed extraction does not fail the upload — the attachment is stored
	// without text either way, and the reason is extractDocument's to have
	// logged.
	if (!extracted.ok) return stored;

	// The text gets its own hash, over the text: attachments of the same
	// document already share the bytes entry by sha, and the text entry should
	// behave the same way rather than being keyed on the document it came from.
	const textSha = await sha256(extracted.text);
	await store(`${ownerKey}-${textSha}`, Buffer.from(extracted.text, "utf-8"), {
		conversation: ownerKey,
		mime: "text/markdown",
		...(tag
			? { messageId: tag.messageId, sha: textSha, extractedFrom: sha, pages: extracted.pages }
			: {}),
	});
	return { ...stored, extracted: { value: textSha, pages: extracted.pages } };
}
