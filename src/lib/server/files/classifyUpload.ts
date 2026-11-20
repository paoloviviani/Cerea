/**
 * What an uploaded file is, decided from its bytes.
 *
 * The one place every upload path (chat, the `/code` attachment route,
 * project documents, knowledge bases) asks: text is whatever decodes as text,
 * whatever its extension or the type the browser guessed (`.drawio`,
 * `.excalidraw`, `.toml`, a file with no extension). Known binary types keep
 * their own handling (documents extracted, audio transcribed, images shown);
 * any other binary is unsupported.
 */
import { fileTypeFromBuffer } from "file-type";
import { TEXT_MIME_ALLOWLIST } from "$lib/constants/mime";
import { mimeMatchesAllowlist } from "$lib/utils/mimeMatch";
import { audioMime, unsupportedAudioMessage } from "./audioAttachment";
import { documentMime, isExtractableDocument } from "./extractDocument";

/** How much of a file is read to decide whether it is text. */
export const TEXT_SNIFF_BYTES = 64 * 1024;

/** The long-paste chip's type, which is plain text (`largeContent.ts` knows it too). */
const CLIPBOARD_MIME = "application/vnd.chatui.clipboard";

/** JSON is parsed to be named JSON only up to this size; past it the type is `text/plain`. */
const JSON_PARSE_MAX_BYTES = 5 * 1024 * 1024;

export const UNSUPPORTED_UPLOAD_MESSAGE =
	"This file type isn't supported: it isn't text, an image, a document or audio.";

function utf16Order(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
	if (bytes.length < 2) return null;
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	return null;
}

/**
 * Whether the bytes are text: valid UTF-8 (a BOM allowed) or UTF-16 with a
 * BOM, with no NUL byte in the first 64 KB. Only the head is read, so a
 * 30 MB file costs no more than a small one.
 */
export function isTextContent(bytes: Uint8Array): boolean {
	const head = bytes.subarray(0, TEXT_SNIFF_BYTES);
	const truncated = bytes.length > head.length;
	const order = utf16Order(head);
	if (order) {
		try {
			// A cut in the middle of a code unit is not an error.
			const even = head.subarray(0, head.length - (head.length % 2));
			new TextDecoder(order, { fatal: true }).decode(even, { stream: truncated });
			return true;
		} catch {
			return false;
		}
	}
	if (head.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: truncated });
		return true;
	} catch {
		return false;
	}
}

/** UTF-16 text with a BOM whose head has no control characters (a binary file would). */
function looksLikeUtf16Text(bytes: Uint8Array): boolean {
	const order = utf16Order(bytes);
	if (!order || !isTextContent(bytes)) return false;
	const head = bytes.subarray(0, TEXT_SNIFF_BYTES);
	const text = new TextDecoder(order).decode(head.subarray(2, head.length - (head.length % 2)));
	// eslint-disable-next-line no-control-regex
	return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text);
}

/** The UTF-8 bytes of a UTF-16 (BOM) text; anything else is returned as it is. */
export function toUtf8Bytes(bytes: Uint8Array): Buffer {
	const order = utf16Order(bytes);
	if (!order) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const text = new TextDecoder(order).decode(bytes.subarray(2));
	return Buffer.from(text, "utf-8");
}

/** Extensions whose type the name states better than the content can. */
const EXTENSION_TEXT_MIME: Record<string, string> = {
	md: "text/markdown",
	markdown: "text/markdown",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	html: "text/html",
	htm: "text/html",
	yaml: "text/yaml",
	yml: "text/yaml",
};

/** A text's type from its first characters: XML, JSON, HTML, else `text/plain`. */
export function sniffTextMime(bytes: Uint8Array): string {
	const head = bytes.subarray(0, TEXT_SNIFF_BYTES);
	const order = utf16Order(head);
	const text = order
		? new TextDecoder(order).decode(head.subarray(2))
		: new TextDecoder("utf-8").decode(head);
	const start = text.trimStart();
	if (/^<!doctype html|^<html[\s>]/i.test(start)) return "text/html";
	if (/^<\?xml\s|^<[A-Za-z_][\w:.-]*[\s/>]/.test(start)) return "application/xml";
	if (start[0] === "{" || start[0] === "[") {
		if (bytes.length > JSON_PARSE_MAX_BYTES) return "text/plain";
		try {
			JSON.parse(new TextDecoder(order ?? "utf-8").decode(bytes));
			return "application/json";
		} catch {
			return "text/plain";
		}
	}
	return "text/plain";
}

/**
 * The type a text file is stored under: the browser's when it is a text type
 * (`text/csv`, `application/json`, the long-paste chip's), else the name's
 * where it states one (`.md`), else what the content looks like.
 */
export function textMimeFor(name: string, declared: string, bytes: Uint8Array): string {
	const type = declared.split(";")[0].trim().toLowerCase();
	if (type === CLIPBOARD_MIME) return type;
	if (type && mimeMatchesAllowlist(type, [...TEXT_MIME_ALLOWLIST])) return type;
	const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
	return EXTENSION_TEXT_MIME[ext] ?? sniffTextMime(bytes);
}

export type UploadClass =
	| { kind: "audio"; mime: string }
	| { kind: "document"; mime: string }
	| { kind: "image"; mime: string }
	/** `bytes` is set when the text had to be re-encoded (UTF-16 becomes UTF-8). */
	| { kind: "text"; mime: string; bytes?: Buffer }
	/** `message` says why, when it is more than "not a known type" (audio we cannot take). */
	| { kind: "unsupported"; mime: string; message?: string };

/** What the browser said, minus an empty or generic type. */
function declaredText(declared: string): boolean {
	const type = declared.split(";")[0].trim().toLowerCase();
	return (
		type === CLIPBOARD_MIME || (!!type && mimeMatchesAllowlist(type, [...TEXT_MIME_ALLOWLIST]))
	);
}

export async function classifyUpload(
	name: string,
	declaredType: string,
	bytes: Uint8Array
): Promise<UploadClass> {
	// UTF-16 LE's byte-order mark is also an MP3 frame sync: text that decodes
	// cleanly, with no control characters, is text before it is anything else.
	if (looksLikeUtf16Text(bytes)) {
		return {
			kind: "text",
			mime: textMimeFor(name, declaredType, bytes),
			bytes: toUtf8Bytes(bytes),
		};
	}
	const sniffedOnly = (await fileTypeFromBuffer(bytes))?.mime;
	const sniffed = sniffedOnly ?? declaredType;

	const audio = audioMime(sniffedOnly, bytes);
	if (audio) return { kind: "audio", mime: audio };

	const doc = documentMime(sniffed, name);
	if (isExtractableDocument(doc)) return { kind: "document", mime: doc };

	if (sniffedOnly?.startsWith("image/")) return { kind: "image", mime: sniffedOnly };
	// A claim of image the bytes carry no signature for (an SVG, a mislabelled
	// file) is kept as declared, as it always was.
	if (!sniffedOnly && declaredType.toLowerCase().startsWith("image/")) {
		return { kind: "image", mime: declaredType };
	}

	// XML is the one text format with a signature of its own.
	if (!sniffedOnly || sniffedOnly === "application/xml") {
		// A declared text type needs only to be free of NUL bytes: a Latin-1 CSV
		// is text the model can read, though it is not UTF-8.
		const textual =
			isTextContent(bytes) ||
			(declaredText(declaredType) &&
				!utf16Order(bytes) &&
				!bytes.subarray(0, TEXT_SNIFF_BYTES).includes(0));
		if (textual) {
			const mime = textMimeFor(name, declaredType, bytes);
			return utf16Order(bytes)
				? { kind: "text", mime, bytes: toUtf8Bytes(bytes) }
				: { kind: "text", mime };
		}
	}
	const message = unsupportedAudioMessage(sniffedOnly, name, declaredType, bytes);
	return {
		kind: "unsupported",
		mime: "application/octet-stream",
		...(message ? { message } : {}),
	};
}
