/**
 * What a knowledge base accepts, decided from the bytes.
 *
 * A base indexes text. A document the local reader extracts (PDF, Office,
 * OpenDocument, e-books) is turned into text first; a plain-text file is
 * indexed as it is. Anything else — an image (those go to the chat model's
 * vision, never to extraction), an archive, a binary — used to be indexed as
 * `bytes.toString("utf-8")`, which is garbage chunks in the index.
 *
 * The type is the one the bytes sniff as, not the browser's `file.type`, the
 * way `writeAttachment` decides for chat attachments.
 */
import { fileTypeFromBuffer } from "file-type";
import { documentMime, isExtractableDocument } from "./extractDocument";

export const KNOWLEDGE_ACCEPTED_LABEL =
	"PDF, Word, Excel, PowerPoint, OpenDocument, e-books and text files";

export const KNOWLEDGE_REFUSED_MESSAGE =
	"Images, archives and other binary files can't be added to a knowledge base. " +
	`Accepted: ${KNOWLEDGE_ACCEPTED_LABEL}.`;

/** The text types the extension names, for bytes that carry no signature. */
const TEXT_EXTENSION_MIME: Record<string, string> = {
	md: "text/markdown",
	markdown: "text/markdown",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	json: "application/json",
	xml: "application/xml",
	html: "text/html",
	htm: "text/html",
	yaml: "text/yaml",
	yml: "text/yaml",
};

/** The share of control bytes a single-byte text may have before it is binary. */
const MAX_CONTROL_RATIO = 0.01;

/** UTF-16 with a byte-order mark: text, but not an encoding this reads. */
export function isUtf16(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 2 &&
		((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
	);
}

/**
 * The text of `bytes`, or null when they are not text this can read: UTF-8
 * (a BOM is stripped), else a single-byte file (what Excel on Windows
 * writes, windows-1252) with almost no control characters. A NUL byte, or
 * UTF-16, is refused.
 */
export function decodeText(bytes: Uint8Array): string | null {
	if (bytes.includes(0) || isUtf16(bytes)) return null;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		let control = 0;
		for (const byte of bytes) {
			if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d)
				control++;
			else if (byte === 0x7f) control++;
		}
		if (control > bytes.length * MAX_CONTROL_RATIO) return null;
		text = new TextDecoder("windows-1252").decode(bytes);
	}
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function isPlainText(bytes: Uint8Array): boolean {
	return decodeText(bytes) !== null;
}

/** Why bytes were refused: an unsupported text encoding is not "binary". */
export function refusalMessage(bytes: Uint8Array): string {
	return isUtf16(bytes)
		? `Text encoding not supported (UTF-16): save as UTF-8. Accepted: ${KNOWLEDGE_ACCEPTED_LABEL}.`
		: KNOWLEDGE_REFUSED_MESSAGE;
}

/**
 * The type a knowledge upload is stored under, or null when it is not
 * accepted. Extractable documents keep their sniffed type; text is stored as
 * the extension suggests (or `text/plain`), whatever the browser claimed.
 */
export async function knowledgeUploadMime(bytes: Buffer, filename: string): Promise<string | null> {
	const sniffed = (await fileTypeFromBuffer(bytes))?.mime;
	if (sniffed) {
		const mime = documentMime(sniffed, filename);
		if (isExtractableDocument(mime)) return mime;
		// A signature that is not a document (image, archive, executable…).
		// Only a few text formats carry one; those are text.
		if (sniffed === "application/xml" && isPlainText(bytes)) return sniffed;
		return null;
	}
	if (!isPlainText(bytes)) return null;
	const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
	return TEXT_EXTENSION_MIME[ext] ?? "text/plain";
}
