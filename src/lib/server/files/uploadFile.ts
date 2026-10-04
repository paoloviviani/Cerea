import type { Conversation } from "$lib/types/Conversation";
import type { MessageFile } from "$lib/types/Message";
import { sha256 } from "$lib/utils/sha256";
import { fileTypeFromBuffer } from "file-type";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import {
	documentMime,
	extractDocument,
	isExtractableDocument,
	type Extraction,
} from "./extractDocument";

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

	// The type is the one the bytes sniff as, falling back to what the browser
	// said — and that one type is used for the deciding, the stored entry and
	// the `MessageFile` alike. A legacy `.doc` saved as `.docx` sniffs as a
	// compound file (`application/x-cfb`) while the browser says "docx"; the
	// two used to disagree, and extraction followed the one the allowlist did
	// not know.
	const sniffed = await fileTypeFromBuffer(buffer).then((fileType) => fileType?.mime ?? file.type);
	const mime = documentMime(sniffed, file.name);

	let extracted: Extraction | undefined;
	if (isExtractableDocument(mime)) {
		extracted = await extractDocument({ bytes: buffer, mime, filename: file.name, token });
		// A failed extraction does not fail the upload — the attachment is stored
		// without text either way, and carries the reason on its `MessageFile`.
		if (!extracted.ok) {
			logger.warn(
				{
					filename: file.name,
					mime,
					sniffed,
					declared: file.type,
					kind: extracted.kind,
					status: extracted.status,
					reason: extracted.reason,
				},
				"attachment_text_unavailable: stored without text"
			);
		}
	} else if (looksLikeDocument(file.name)) {
		logger.info(
			{ filename: file.name, sniffed, declared: file.type },
			"document_extraction_skipped: the bytes are not a type a reader takes"
		);
	}

	await store(`${ownerKey}-${sha}`, Buffer.from(buffer), {
		conversation: ownerKey,
		mime,
		...(tag
			? {
					messageId: tag.messageId,
					sha,
					name: file.name,
					declaredMime: file.type,
					...(extracted && !extracted.ok
						? { extractionKind: extracted.kind, extractionReason: extracted.reason }
						: {}),
				}
			: {}),
	});

	const stored: MessageFile = { type: "hash", value: sha, mime, name: file.name };
	if (!extracted) return stored;
	if (!extracted.ok) {
		return { ...stored, extractionError: { kind: extracted.kind, reason: extracted.reason } };
	}

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

/** A name that says "document", for the log line of a skip that is worth a line. */
function looksLikeDocument(name: string): boolean {
	return /\.(pdf|docx?|xlsx?|pptx?|od[tsp]|epub|rtf)$/i.test(name);
}
