import { fileTypeFromBuffer } from "file-type";
import { documentMime } from "$lib/server/files/extractDocument";
import { MAX_DELIVERABLE_BYTES, storeDeliverable } from "$lib/server/execution/deliverables";
import type { PersistedDeliverableRef } from "$lib/types/ParkedCall";
import type { Conversation } from "$lib/types/Conversation";
import type { User } from "$lib/types/User";
import { logger } from "$lib/server/logger";

/**
 * Files an MCP tool returns become conversation files; the model never sees their bytes.
 *
 * A connector can hand a file back three ways: an MCP `resource` block with a `blob`, `image` or `audio`
 * content, or base64 text inside the JSON of the result (`download-bytes` of the Microsoft 365 server).
 * Left alone the last one is 15,000 characters of base64 the model has to copy into `execute_code`, which
 * is slow, error-prone and fills the context. Here every file is stored once as a deliverable (the same
 * store generated images and code outputs use) and what the model reads, and what is persisted on the
 * message, carries a short note in its place.
 *
 * This is the one step every MCP result goes through (`executeToolCalls`, and the two resume paths in
 * `resumeElicitation`); it takes the result of `callMcpTool` and returns the same shape, cleaned.
 */

/** A string shorter than this is never taken for a file: real files are bigger, and ids and tokens are not. */
export const MIN_BASE64_CHARS = 1024;

/** Files one result may add; past it each further one gets a note only. */
export const MAX_FILES_PER_RESULT = 20;

/** The result of a tool call, as `callMcpTool` returns it, to the extent this step reads it. */
export interface ToolResultBody {
	text: string;
	structured?: unknown;
	content?: unknown[];
}

export interface ResultFilesContext {
	conversationId?: Conversation["_id"];
	userId?: User["_id"];
	messageId?: string;
	/** The tool's name, recorded on each file row. */
	tool: string;
	/** The call's arguments (primitives are enough): a `fileName` argument names the file it fetched. */
	args?: Record<string, unknown>;
	/** Test seam: the store. Defaults to `storeDeliverable`. */
	store?: typeof storeDeliverable;
}

export interface ResultFilesOutcome extends ToolResultBody {
	/** The files stored (or already stored), in order, for the card's file list. */
	refs: PersistedDeliverableRef[];
}

/** Formats a stored file may have when it is found by its bytes alone: signatures that do not occur by accident. */
const KNOWN_EXTENSIONS = new Set([
	"pdf",
	"png",
	"jpg",
	"gif",
	"webp",
	"bmp",
	"tif",
	"heic",
	"avif",
	"zip",
	"docx",
	"xlsx",
	"pptx",
	"odt",
	"ods",
	"odp",
	"epub",
	"cfb",
	"gz",
	"7z",
	"rar",
	"tar",
	"xz",
	"bz2",
	"mp4",
	"mov",
	"webm",
	"mkv",
	"wav",
	"ogg",
	"flac",
	"m4a",
	"sqlite",
	"parquet",
	"rtf",
]);

const NAME_KEYS = ["name", "fileName", "filename", "file_name", "title"];
const ARG_NAME_KEYS = ["fileName", "filename", "file_name", "name"];

const MIME_EXTENSION: Record<string, string> = {
	"application/pdf": "pdf",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/ogg": "ogg",
	"audio/webm": "webm",
	"audio/flac": "flac",
	"audio/mp4": "m4a",
	"audio/aac": "aac",
	"text/plain": "txt",
	"text/csv": "csv",
	"application/json": "json",
	"application/zip": "zip",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** What the note calls a file, from its extension. */
const KIND_LABEL: Record<string, string> = {
	xlsx: "Excel",
	xls: "Excel",
	docx: "Word",
	doc: "Word",
	pptx: "PowerPoint",
	ppt: "PowerPoint",
	pdf: "PDF",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	csv: "CSV",
};

/** Files `doc_read`/`look_doc` open. */
const DOCUMENT_EXTENSIONS = new Set([
	"xlsx",
	"xls",
	"docx",
	"doc",
	"pptx",
	"ppt",
	"pdf",
	"odt",
	"ods",
	"odp",
]);

const BASE64_HEAD = /^[A-Za-z0-9+/\-_\s]+={0,2}$/;

function extensionOf(name: string): string {
	return name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
}

/** A file name safe to store: a last path segment, no control characters, no leading dots, bounded. */
export function safeFileName(raw: string): string {
	const base = (raw.replace(/\\/g, "/").split("/").pop() ?? "")
		// eslint-disable-next-line no-control-regex -- control bytes are valid filename attacks
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/^[.\s]+/, "")
		.trim();
	if (!base) return "";
	const ext = extensionOf(base);
	if (!ext) return base.slice(0, 100);
	const stem = base.slice(0, base.length - ext.length - 1).trimEnd();
	return `${stem.slice(0, 100) || "file"}.${ext}`;
}

/** The last path segment of a resource uri, decoded when it can be. */
function nameFromUri(uri: unknown): string {
	if (typeof uri !== "string" || !uri) return "";
	let path = uri;
	try {
		path = new URL(uri).pathname;
	} catch {
		path = uri.split(/[?#]/)[0] ?? "";
	}
	const last = path.split("/").filter(Boolean).pop() ?? "";
	try {
		return decodeURIComponent(last);
	} catch {
		return last;
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The note that replaces a stored file's bytes. */
export function savedNote(name: string, size: number): string {
	const ext = extensionOf(name);
	const kind = KIND_LABEL[ext];
	const detail = kind ? `${formatSize(size)}, ${kind}` : formatSize(size);
	const how = DOCUMENT_EXTENSIONS.has(ext)
		? `open it with doc_read/look_doc or at /mnt/data/${name} in code`
		: `use it at /mnt/data/${name} in code`;
	return `[file saved to this conversation: ${name} (${detail}); ${how}]`;
}

export function notSavedNote(reason: string): string {
	return `[a file was returned but could not be saved: ${reason}]`;
}

function tooLargeNote(bytes: number): string {
	return `[a file of ${formatSize(bytes)} was returned but is larger than the ${Math.floor(MAX_DELIVERABLE_BYTES / (1024 * 1024))} MB limit, so it was not saved]`;
}

interface Candidate {
	/** The base64 payload, without a `data:` prefix and without whitespace. */
	b64: string;
	mime?: string;
}

/** Strips a `data:...;base64,` prefix; returns the declared type and the payload. */
function splitDataUri(value: string): { mime?: string; payload: string } {
	const m = /^data:([^;,]*)(?:;[^,]*)*;base64,/i.exec(value);
	if (!m) return { payload: value };
	return { ...(m[1] ? { mime: m[1] } : {}), payload: value.slice(m[0].length) };
}

/** Whether the base64 text is a plausible payload of a whole number of bytes (url-safe or padded). */
function plausibleBase64(payload: string): boolean {
	// A linear scan: a regular expression over a multi-megabyte string is slow.
	let chars = 0;
	let padding = 0;
	for (let i = 0; i < payload.length; i += 1) {
		const c = payload.charCodeAt(i);
		if (c === 61) {
			padding += 1;
			if (padding > 2) return false;
		} else if (c === 32 || c === 10 || c === 13 || c === 9) {
			continue;
		} else if (padding > 0) {
			return false;
		} else if (
			(c >= 65 && c <= 90) ||
			(c >= 97 && c <= 122) ||
			(c >= 48 && c <= 57) ||
			c === 43 ||
			c === 47 ||
			c === 45 ||
			c === 95
		) {
			chars += 1;
		} else {
			return false;
		}
	}
	return chars % 4 !== 1;
}

function estimatedBytes(b64: string): number {
	const clean = b64.replace(/=+$/, "");
	return Math.floor((clean.length * 3) / 4);
}

function decode(b64: string): Buffer {
	return Buffer.from(b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** The format of these bytes when they begin with a known file signature, else null. */
async function sniff(bytes: Buffer): Promise<{ mime: string; ext: string } | null> {
	const type = await fileTypeFromBuffer(new Uint8Array(bytes)).catch(() => undefined);
	if (!type || !KNOWN_EXTENSIONS.has(type.ext)) return null;
	return { mime: type.mime, ext: type.ext };
}

/**
 * Whether a string value is a file: long enough, base64 all through, and its first bytes carry a known
 * file signature. Only a prefix is decoded to decide, so an ordinary long string costs almost nothing.
 */
async function asFileValue(value: string): Promise<Candidate | null> {
	if (value.length < MIN_BASE64_CHARS) return null;
	const { mime, payload } = splitDataUri(value.trim());
	if (payload.length < MIN_BASE64_CHARS) return null;
	const head = payload.slice(0, 4096);
	if (!BASE64_HEAD.test(head)) return null;
	const type = await sniff(decode(head));
	if (!type) return null;
	if (!plausibleBase64(payload)) return null;
	return { b64: payload.replace(/\s+/g, ""), ...(mime ? { mime } : {}) };
}

/** Walks a result, storing each file found and replacing it by its note. One instance per tool result. */
class Saver {
	readonly refs: PersistedDeliverableRef[] = [];
	private seen = new Map<string, string>();
	private fallbackCount = 0;
	private files = 0;

	constructor(private ctx: ResultFilesContext) {}

	private argName(): string {
		for (const key of ARG_NAME_KEYS) {
			const v = this.ctx.args?.[key];
			if (typeof v === "string" && v.trim()) return v;
		}
		return "";
	}

	/** Stores one payload and returns the note for the model. `wanted` is the best name known, may be empty. */
	async save(
		b64: string,
		wanted: string,
		declaredMime: string | undefined,
		fallbackStem: string,
		requireSignature: boolean
	): Promise<string> {
		const cached = this.seen.get(b64);
		if (cached) return cached;
		const note = await this.saveNew(b64, wanted, declaredMime, fallbackStem, requireSignature);
		this.seen.set(b64, note);
		return note;
	}

	private async saveNew(
		b64: string,
		wanted: string,
		declaredMime: string | undefined,
		fallbackStem: string,
		requireSignature: boolean
	): Promise<string> {
		const size = estimatedBytes(b64);
		if (size > MAX_DELIVERABLE_BYTES) return tooLargeNote(size);
		if (this.files >= MAX_FILES_PER_RESULT) {
			return notSavedNote(`a result may add ${MAX_FILES_PER_RESULT} files and this one has more`);
		}
		if (!this.ctx.conversationId) return notSavedNote("there is no conversation to keep it in");
		try {
			const bytes = decode(b64);
			if (bytes.byteLength === 0) return notSavedNote("it was empty");
			const type = await sniff(bytes);
			if (!type && requireSignature) return notSavedNote("it is not a recognised file");

			let name = safeFileName(wanted);
			const wantedExt = extensionOf(name);
			const extension =
				type?.ext ??
				(declaredMime
					? MIME_EXTENSION[declaredMime.toLowerCase().split(";")[0].trim()]
					: undefined) ??
				"bin";
			if (!name) {
				this.fallbackCount += 1;
				name = `${fallbackStem}-${this.fallbackCount}.${extension}`;
			} else if (!wantedExt) {
				name = `${name}.${extension}`;
			}
			const sniffedMime = type
				? documentMime(type.mime, name)
				: declaredMime && declaredMime !== "application/octet-stream"
					? declaredMime.split(";")[0].trim()
					: "application/octet-stream";

			this.files += 1;
			const store = this.ctx.store ?? storeDeliverable;
			const stored = await store({
				conversationId: this.ctx.conversationId,
				...(this.ctx.userId ? { userId: this.ctx.userId } : {}),
				name,
				mime: sniffedMime,
				bytes,
				tool: this.ctx.tool,
				summary: `Returned by ${this.ctx.tool}`,
				...(this.ctx.messageId ? { messageId: this.ctx.messageId } : {}),
			});
			if (!stored.ok) return notSavedNote(stored.error);
			this.refs.push(stored.ref);
			return savedNote(stored.ref.name, stored.ref.size);
		} catch (err) {
			logger.warn({ err, tool: this.ctx.tool }, "[mcp] a file a tool returned could not be saved");
			return notSavedNote("the store failed");
		}
	}

	/** A value in a JSON tree; `owner` is the object it is a property of, for a sibling name. */
	async walk(
		value: unknown,
		owner: Record<string, unknown> | undefined,
		depth = 0
	): Promise<unknown> {
		if (depth > 24) return value;
		if (typeof value === "string") {
			const file = await asFileValue(value);
			if (!file) return value;
			let wanted = "";
			if (owner) {
				for (const key of NAME_KEYS) {
					const sibling = owner[key];
					if (typeof sibling === "string" && sibling.trim() && sibling.length <= 255) {
						wanted = sibling;
						break;
					}
				}
			}
			return this.save(file.b64, wanted || this.argName(), file.mime, "file", true);
		}
		if (Array.isArray(value)) {
			const out: unknown[] = [];
			for (const item of value) out.push(await this.walk(item, undefined, depth + 1));
			return out;
		}
		if (typeof value === "object" && value !== null) {
			const obj = value as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const [key, v] of Object.entries(obj)) out[key] = await this.walk(v, obj, depth + 1);
			return out;
		}
		return value;
	}

	/** A text part: JSON gets its base64 values replaced in place; a bare base64 body is replaced whole. */
	async text(text: string): Promise<string> {
		if (text.length < MIN_BASE64_CHARS) return text;
		const trimmed = text.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				return text;
			}
			const before = JSON.stringify(parsed);
			const walked = await this.walk(parsed, undefined);
			const after = JSON.stringify(walked);
			if (after === before) return text;
			return JSON.stringify(walked, null, trimmed.includes("\n") ? 2 : undefined);
		}
		const file = await asFileValue(trimmed);
		if (!file) return text;
		return this.save(file.b64, this.argName(), file.mime, "file", true);
	}

	/** One content block: returns the block to keep and any note for the model. */
	async block(block: unknown): Promise<{ block: unknown; note?: string; text?: string }> {
		if (typeof block !== "object" || block === null) return { block };
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			const text = await this.text(b.text);
			return text === b.text ? { block } : { block: { ...b, text }, text };
		}
		if (b.type === "resource" && typeof b.resource === "object" && b.resource !== null) {
			const r = b.resource as Record<string, unknown>;
			if (typeof r.blob !== "string") return { block };
			const mimeType = typeof r.mimeType === "string" ? r.mimeType : undefined;
			const { payload } = splitDataUri(r.blob);
			const clean = payload.replace(/\s+/g, "");
			const wanted =
				nameFromUri(r.uri) ||
				(typeof r.name === "string" ? r.name : "") ||
				(typeof r.title === "string" ? r.title : "") ||
				(typeof b.name === "string" ? b.name : "") ||
				(typeof b.title === "string" ? b.title : "");
			const note = plausibleBase64(clean)
				? await this.save(clean, wanted || this.argName(), mimeType, "file", false)
				: notSavedNote("its data was not valid base64");
			const { blob: _blob, ...rest } = r;
			void _blob;
			return { block: { ...b, resource: { ...rest, text: note } }, note };
		}
		if ((b.type === "image" || b.type === "audio") && typeof b.data === "string") {
			const mimeType = typeof b.mimeType === "string" ? b.mimeType : undefined;
			const { payload } = splitDataUri(b.data);
			const clean = payload.replace(/\s+/g, "");
			const note = plausibleBase64(clean)
				? await this.save(clean, this.argName(), mimeType, b.type, false)
				: notSavedNote("its data was not valid base64");
			return { block: { type: "text", text: note }, note };
		}
		return { block };
	}
}

/**
 * Stores the files in an MCP tool result and returns the result without their bytes: each payload is
 * replaced by a note, in the text the model reads, in `structured` and in the raw `content` blocks that are
 * persisted on the message. Never throws, and never fails the call: a file that cannot be stored becomes a
 * note saying so.
 */
export async function saveResultFiles(
	result: ToolResultBody,
	ctx: ResultFilesContext
): Promise<ResultFilesOutcome> {
	const saver = new Saver(ctx);
	try {
		const blocks = Array.isArray(result.content) ? result.content : undefined;
		let text = result.text ?? "";
		let content = blocks;
		if (blocks) {
			const hasTextPart = blocks.some(
				(b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text"
			);
			const kept: unknown[] = [];
			const texts: string[] = [];
			const notes: string[] = [];
			for (const raw of blocks) {
				const out = await saver.block(raw);
				kept.push(out.block);
				const b = raw as { type?: unknown; text?: unknown } | null;
				if (b && b.type === "text" && typeof b.text === "string") texts.push(out.text ?? b.text);
				else if (out.note) notes.push(out.note);
			}
			content = kept;
			// The text the model reads is the text parts (as `callMcpTool` joins them) plus a note per
			// file that came as a block of its own.
			text = hasTextPart ? texts.join("\n") : await saver.text(text);
			if (notes.length) text = [text, ...notes].filter(Boolean).join("\n");
		} else {
			text = await saver.text(text);
		}
		const structured =
			result.structured === undefined ? undefined : await saver.walk(result.structured, undefined);
		return {
			text,
			...(structured !== undefined ? { structured } : {}),
			...(content ? { content } : {}),
			refs: saver.refs,
		};
	} catch (err) {
		// Whatever went wrong, the bytes still must not reach the model.
		logger.warn({ err, tool: ctx.tool }, "[mcp] a tool result could not be scanned for files");
		return {
			text: result.text,
			structured: result.structured,
			content: result.content,
			refs: saver.refs,
		};
	}
}
