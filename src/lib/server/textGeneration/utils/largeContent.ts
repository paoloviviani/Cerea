import { TEXT_MIME_ALLOWLIST } from "$lib/constants/mime";
import type { MessageFile } from "$lib/types/Message";
import { MOUNT_ROOT } from "$lib/utils/execution/protocol";

/**
 * Large text reaches the model as a file it reads with code, not inlined.
 *
 * A text attachment, an extracted document's text or a long paste that would
 * take too much of the context window is replaced in the prompt by a pointer:
 * its name, size and line count, a short sample, and where the whole content
 * is in the sandbox. Nothing here parses the content; the size is the text
 * length over `CHARS_PER_TOKEN_ESTIMATE`.
 */

/** The estimate the threshold is judged by: one token per this many characters. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Content past this share of the context window is turned into file pointers. */
export const LARGE_CONTENT_WINDOW_SHARE = 0.25;

/** The same share of the history ceiling, when the model reports no window. */
export const FALLBACK_LARGE_CONTENT_CHARS = 100_000;

/**
 * The same, for prose, when the model reports no window: 200,000 characters
 * is about 50k tokens, which is a transcript or report of that size inlined
 * on any model with a 128k window (the usual case for an alias that reports
 * none) while still leaving most of the window for the answer. Prose is read
 * straight through, where data is only ever queried, so inlining it is cheap
 * and a pointer is the worse outcome. Not a setting.
 */
export const FALLBACK_LARGE_PROSE_CHARS = 200_000;

/** What the sample shows of a pointed-at content: its start, and its end. */
export const SAMPLE_HEAD_CHARS = 3_000;
export const SAMPLE_TAIL_CHARS = 500;
/** Prose gets a longer end: a transcript's latest state is at the end. */
export const PROSE_SAMPLE_TAIL_CHARS = 2_000;

export type ContentKind = "data" | "prose" | "unknown";

const DATA_EXTENSIONS = new Set([
	"json",
	"jsonl",
	"ndjson",
	"csv",
	"tsv",
	"log",
	"xml",
	"yaml",
	"yml",
	"sql",
]);
const PROSE_EXTENSIONS = new Set(["md", "markdown", "txt", "text", "rst"]);
/** Extracted documents: their text is what the prompt carries. */
const DOCUMENT_EXTENSIONS = new Set(["docx", "doc", "odt", "rtf", "pdf", "pptx", "ppt", "epub"]);
const DATA_MIME = /(json|csv|tab-separated|xml|yaml|sql|ndjson)/;

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Most of the first lines have the same number (two or more) of one delimiter. */
function looksDelimited(sample: string): boolean {
	const lines = sample
		.split("\n")
		.filter((line) => line.trim() !== "")
		.slice(0, 20);
	if (lines.length < 3) return false;
	return [",", "\t", "|", ";"].some((delimiter) => {
		const counts = lines.map((line) => line.split(delimiter).length - 1);
		const common = counts[0];
		return common >= 2 && counts.filter((count) => count === common).length >= lines.length * 0.8;
	});
}

/** Sentences or headings: lines of several words, ending in punctuation or a heading. */
function looksLikeProse(sample: string): boolean {
	const lines = sample.split("\n").filter((line) => line.trim() !== "");
	if (lines.length === 0) return false;
	const prose = lines.filter(
		(line) =>
			/^#{1,6}\s+\S/.test(line) || (/\S+\s+\S+\s+\S+/.test(line) && /[.!?:)"”]$/.test(line.trim()))
	);
	return prose.length >= lines.length * 0.4;
}

/**
 * What a content is, cheaply and without parsing it: the file name or MIME,
 * then a look at the head sample. Data is queried with code; prose is read.
 */
export function classifyContent(input: { name: string; mime?: string; text: string }): ContentKind {
	const extension = extensionOf(input.name);
	const mime = (input.mime || "").toLowerCase();
	if (DATA_EXTENSIONS.has(extension)) return "data";
	if (extension === "md" || extension === "markdown" || mime === "text/markdown") return "prose";
	const sample = input.text.slice(0, SAMPLE_HEAD_CHARS);
	const first = sample.trimStart()[0];
	if (!extension || PROSE_EXTENSIONS.has(extension)) {
		if (first === "{" || first === "[") return "data";
	}
	if (extension === "" && DATA_MIME.test(mime)) return "data";
	if (looksDelimited(sample)) return "data";
	if (
		PROSE_EXTENSIONS.has(extension) ||
		DOCUMENT_EXTENSIONS.has(extension) ||
		mime.startsWith("text/plain") ||
		mime === CLIPBOARD_MIME
	)
		return looksLikeProse(sample) ? "prose" : "unknown";
	return "unknown";
}

/** The long-paste chip's type, which is plain text. */
export const CLIPBOARD_MIME = "application/vnd.chatui.clipboard";

/** Whether the prompt carries this file as text (a paste included). */
export function isTextFile(file: Pick<MessageFile, "mime">): boolean {
	const mime = (file.mime || "").toLowerCase();
	if (mime === CLIPBOARD_MIME) return true;
	const [fileType, fileSubtype] = mime.split("/");
	return TEXT_MIME_ALLOWLIST.some((allowed) => {
		const [type, subtype] = allowed.toLowerCase().split("/");
		return (type === "*" || type === fileType) && (subtype === "*" || subtype === fileSubtype);
	});
}

/**
 * The characters of text one message may carry before the largest is pointed
 * at instead: 25% of the window in tokens, at the estimate above. Without a
 * window, 25% of the fallback history budget.
 */
export function largeContentThresholdChars(
	contextLengthTokens?: number,
	kind: ContentKind = "data"
): number {
	if (!contextLengthTokens || contextLengthTokens <= 0)
		return kind === "prose" ? FALLBACK_LARGE_PROSE_CHARS : FALLBACK_LARGE_CONTENT_CHARS;
	return Math.floor(contextLengthTokens * LARGE_CONTENT_WINDOW_SHARE * CHARS_PER_TOKEN_ESTIMATE);
}

/** About what a pointer costs, so a content smaller than that is never worth one. */
const POINTER_COST_CHARS = SAMPLE_HEAD_CHARS + PROSE_SAMPLE_TAIL_CHARS + 1_000;

/**
 * Which of one message's contents become pointers: the largest first, until
 * the rest fit under the threshold. Returns the indexes into `sizes`.
 */
export function pickLargest(sizes: readonly number[], thresholdChars: number): Set<number> {
	const picked = new Set<number>();
	let total = sizes.reduce((sum, size) => sum + size, 0);
	while (total > thresholdChars) {
		let largest = -1;
		sizes.forEach((size, index) => {
			if (!picked.has(index) && (largest < 0 || size > sizes[largest])) largest = index;
		});
		// Nothing left that a pointer would shrink.
		if (largest < 0 || sizes[largest] <= POINTER_COST_CHARS) break;
		picked.add(largest);
		total -= sizes[largest] - POINTER_COST_CHARS;
	}
	return picked;
}

/** Lines in a text: a final newline does not start another one. */
export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (
		let at = text.indexOf("\n");
		at >= 0 && at < text.length - 1;
		at = text.indexOf("\n", at + 1)
	)
		lines += 1;
	return lines;
}

/**
 * The start and the end of a text, cut at line ends. A part with no line end
 * inside it (one huge line) is cut at the character count instead.
 */
export function sampleOf(
	text: string,
	tailChars: number = SAMPLE_TAIL_CHARS
): { head: string; tail: string } {
	let head = text.slice(0, SAMPLE_HEAD_CHARS);
	if (text.length > head.length) {
		const cut = head.lastIndexOf("\n");
		if (cut > 0) head = head.slice(0, cut);
	}
	const tailStart = Math.max(head.length, text.length - tailChars);
	let tail = text.slice(tailStart);
	// Begin at a line start unless the part starts the text's own line already.
	if (tailStart > 0 && text[tailStart - 1] !== "\n") {
		const cut = tail.indexOf("\n");
		if (cut >= 0 && cut < tail.length - 1) tail = tail.slice(cut + 1);
	}
	return { head, tail };
}

function size(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} bytes`;
}

export interface LargeContentInput {
	/** The name the model is shown: the attachment's, or the paste's file name. */
	name: string;
	mime: string;
	text: string;
	/** Where the original is under /mnt/data; absent when it is not mounted. */
	mountName?: string;
	/** Where the extracted text is under /mnt/data (`<name>.md`), for a document. */
	mountTextName?: string;
	codeToolOffered: boolean;
	delegateToolOffered: boolean;
}

/** The note when code can read the file. */
export function readWithCodeNote(input: {
	readPath: string;
	originalPath?: string;
	delegateToolOffered: boolean;
	kind?: ContentKind;
}): string {
	const where = input.originalPath
		? `The full extracted text is at ${input.readPath} (the original file is at ${input.originalPath}).`
		: `The full content is at ${input.readPath}.`;
	const chunks = input.delegateToolOffered
		? "If they agree, split it with code and dispatch one sub-agent per chunk with the delegate tool, " +
			"one after another. Give each the user's instruction first, then your running notes so far, then its chunk. " +
			"Answer from the final notes."
		: "If they agree, split it with code and read it chunk by chunk, keeping running notes, " +
			"then answer from the final notes.";
	if (input.kind === "prose")
		return (
			`${where} This is a document or text to read, not data to parse. ` +
			"Do not run code on it unless the user asks for something computational, such as counting or searching. " +
			"If it is a transcript of an earlier conversation, or the user asks to resume or continue it, " +
			"answer from the sample above (its start and end usually hold the topic and the latest state), " +
			"ask the user what they want to pick up, and offer to read it in full in chunks if they need details. " +
			"Otherwise, if the request needs it read in full (to summarise or review it), " +
			"ask the user first whether to read it in chunks. " +
			chunks
		);
	if (input.kind === "unknown")
		return (
			`${where} Look at the sample and decide how to read it: ` +
			"read prose as text, and use code (execute_code) only for data, " +
			"to filter, query or summarise it, never to print it whole. " +
			"If the request needs it read in full (to summarise or review it), " +
			"ask the user first whether to read it in chunks. " +
			chunks
		);
	return (
		`${where} Read it with code (execute_code) only as far as you need. ` +
		"Structured data (JSON, CSV, logs): filter, query or summarise it with code; never print it whole. " +
		"If it is prose and the request needs it read in full (to summarise or review it), " +
		"ask the user first whether to read it in chunks. " +
		chunks
	);
}

/** The note when code cannot run, or the content is not in the sandbox. */
export const NO_CODE_NOTE =
	"This content is too large for this model, and code is not available here to read it, " +
	"so only the sample above is shown. Tell the user plainly that it is too large for this model " +
	"and cannot be read in full here, and suggest they switch to a model with a larger context window " +
	"or shorten the content. Do not answer as if you had read all of it.";

/** What the model reads instead of a large content. */
export function largeContentBlock(input: LargeContentInput): string {
	const { text } = input;
	const kind = classifyContent({ name: input.name, mime: input.mime, text });
	const { head, tail } = sampleOf(
		text,
		kind === "prose" ? PROSE_SAMPLE_TAIL_CHARS : SAMPLE_TAIL_CHARS
	);
	const omitted = text.length - head.length - tail.length;
	const readable = input.codeToolOffered && input.mountName;
	const readName = input.mountTextName ?? input.mountName;
	const note = readable
		? readWithCodeNote({
				readPath: `${MOUNT_ROOT}/${readName}`,
				originalPath: input.mountTextName ? `${MOUNT_ROOT}/${input.mountName}` : undefined,
				delegateToolOffered: input.delegateToolOffered,
				kind,
			})
		: NO_CODE_NOTE;
	const facts = `Large content: ${size(Buffer.byteLength(text))}, ${countLines(text)} lines. Not included in full.`;
	const sample = [
		"Start:",
		head,
		...(omitted > 0 ? ["[... omitted ...]"] : []),
		...(tail ? ["End:", tail] : []),
	].join("\n");
	return `<document name="${input.name}" type="${input.mime}">\n${facts}\n${sample}\n${note}\n</document>`;
}
