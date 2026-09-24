import { DOCUMENT_MIME_ALLOWLIST } from "$lib/constants/mime";
import { findAttachments, readAttachment } from "$lib/server/files/attachmentStore";
import type { Attachment } from "$lib/types/machineProtocol";
import type { MessageFile } from "$lib/types/Message";

/** Chat's long-paste chip: plain text under its own type so chat can render it as a chip. */
const CLIPBOARD_MIME = "application/vnd.chatui.clipboard";

/**
 * The files a person uploaded for one outgoing message (the attachment store, keyed by the
 * session's owner key and the message's id), as the machine's `session.prompt` attachments.
 *
 * Bytes travel inline as data URLs over the machine's own socket; the machine never reaches
 * back into Cerea for them. A document goes as the markdown the store extracted at upload
 * (the coding agent has no PDF or Office reader of its own); a long paste goes as the plain
 * text it is.
 */
export async function promptAttachments(
	ownerKey: string,
	messageId: string
): Promise<Attachment[]> {
	const files = await findAttachments(ownerKey, messageId);
	const attachments: Attachment[] = [];
	for (const file of files) {
		if (file.type === "hash") attachments.push(await toAttachment(ownerKey, file));
	}
	return attachments;
}

async function toAttachment(ownerKey: string, file: MessageFile): Promise<Attachment> {
	if (file.extracted && (DOCUMENT_MIME_ALLOWLIST as readonly string[]).includes(file.mime)) {
		const markdown = await readAttachment(file.extracted.value, ownerKey);
		return dataUrl("text/markdown", `${file.name}.md`, markdown.value);
	}
	const bytes = await readAttachment(file.value, ownerKey);
	const mime =
		(bytes.mime ?? file.mime) === CLIPBOARD_MIME ? "text/plain" : (bytes.mime ?? file.mime);
	return dataUrl(mime, file.name, bytes.value);
}

function dataUrl(mime: string, filename: string, base64: string): Attachment {
	return { type: "file", mime, filename, url: `data:${mime};base64,${base64}` };
}
