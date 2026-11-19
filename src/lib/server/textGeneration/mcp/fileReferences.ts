import type { ObjectId } from "mongodb";
import { branchOf } from "$lib/server/execution/fileVersions";
import { MOUNT_ROOT, OUTPUT_ROOT } from "$lib/utils/execution/protocol";
import { findConversationFile, type ConversationFile } from "../builtinTools/conversationFiles";

/**
 * File references in connector (MCP) tool arguments.
 *
 * The sandbox has no network, so a file the model made (or the user attached) cannot be sent to a
 * connector by code. Inlining it into the call's arguments costs the model's output budget (a few
 * hundred KB of SVG or base64 ends in a cut-off call). Instead the model writes a reference where a
 * string argument goes, naming the file by the path it is shown:
 *
 *     {"$file": "/mnt/data/report.pdf"}                       an attachment of the user, as sent
 *     {"$file": "/mnt/output/diagram.svg"}                    a file produced in the conversation (newest version)
 *     {"$file": "/mnt/output/logo.png", "encoding": "base64"} the bytes as base64 (the default is UTF-8 text)
 *     {"$file": "diagram.svg"}                                a bare name, only when exactly one file has it
 *
 * The server swaps in the content just before the call. A bare name that an attachment and a
 * produced file (or two different files) share is refused with the candidates and their explicit
 * paths: a silent pick once sent the user's attachment instead of the model's own file.
 *
 * An object with a `$file` key is the only thing that is ever rewritten. A string argument that is
 * nothing but such an object serialised as JSON is refused (it would otherwise be committed as
 * literal text); any other string, including one mentioning "$file", is never touched.
 *
 * The call as the model made it (references, not bytes) is what the approval card, the stored
 * message and the logs keep: `resolveFileReferences` returns a copy and never mutates its input.
 * It also returns one note per reference saying which file was sent, for the model to read.
 */

/** Largest single file a reference may stand for. */
export const MAX_FILE_REF_BYTES = 8 * 1024 * 1024;
/** Largest total across the references of one call (the same file twice counts twice). */
export const MAX_FILE_REF_TOTAL_BYTES = 16 * 1024 * 1024;

export const FILE_REF_KEY = "$file";

export type FileRefEncoding = "utf8" | "base64";

export interface FileRefContext {
	conversationId: ObjectId;
	/** The assistant message the call belongs to: limits the files to that branch of the conversation. */
	messageId?: string;
}

export type FileRefResult =
	| { ok: true; args: Record<string, unknown>; resolved: number; notes: string[] }
	| { ok: false; error: string };

type LookupFile = (
	conversationId: ObjectId,
	name: string,
	options: { branch?: ReadonlySet<string>; source?: "attachment" | "output" }
) => Promise<ConversationFile>;

const DATA_PREFIX = `${MOUNT_ROOT}/`;
const OUTPUT_PREFIX = `${OUTPUT_ROOT}/`;

function isRefObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.prototype.hasOwnProperty.call(value, FILE_REF_KEY)
	);
}

interface FoundRef {
	ref: Record<string, unknown>;
	/** Where it sits in the arguments, e.g. `files[0].content`. */
	at: string;
}

/** Every reference in the arguments, depth first. */
function collectRefs(node: unknown, at = "", found: FoundRef[] = []): FoundRef[] {
	if (Array.isArray(node)) {
		node.forEach((item, i) => collectRefs(item, `${at}[${i}]`, found));
	} else if (isRefObject(node)) {
		found.push({ ref: node, at: at || "(arguments)" });
	} else if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			collectRefs(value, at ? `${at}.${key}` : key, found);
		}
	}
	return found;
}

/** The first string whose whole value is a JSON object with a `$file` key, if any. */
function findStringifiedRef(node: unknown, at = ""): string | undefined {
	if (typeof node === "string") {
		const text = node.trim();
		if (!text.startsWith("{") || !text.includes(FILE_REF_KEY)) return undefined;
		try {
			const parsed: unknown = JSON.parse(text);
			return isRefObject(parsed) ? at || "(arguments)" : undefined;
		} catch {
			return undefined;
		}
	}
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i += 1) {
			const hit = findStringifiedRef(node[i], `${at}[${i}]`);
			if (hit) return hit;
		}
	} else if (node && typeof node === "object" && !isRefObject(node)) {
		for (const [key, value] of Object.entries(node)) {
			const hit = findStringifiedRef(value, at ? `${at}.${key}` : key);
			if (hit) return hit;
		}
	}
	return undefined;
}

/** True when the arguments hold at least one `{"$file": ...}` reference. */
export function hasFileRefs(args: unknown): boolean {
	return collectRefs(args).length > 0;
}

interface ParsedRef {
	/** The name as written (a path or a bare name), trimmed. */
	written: string;
	/** The name to look up, without the root. */
	name: string;
	/** Which store the path selects; `undefined` for a bare name. */
	source?: "attachment" | "output";
	encoding: FileRefEncoding;
}

function parseRef(ref: Record<string, unknown>): ParsedRef | string {
	const written = ref[FILE_REF_KEY];
	if (typeof written !== "string" || !written.trim()) {
		return `A file reference needs the file's path: {"$file": "${DATA_PREFIX}<name>"} for an attachment or {"$file": "${OUTPUT_PREFIX}<name>"} for a file you produced.`;
	}
	for (const key of Object.keys(ref)) {
		if (key !== FILE_REF_KEY && key !== "encoding") {
			return `A file reference takes only "$file" and an optional "encoding" ("utf8" or "base64"), not "${key}".`;
		}
	}
	const encoding = ref.encoding ?? "utf8";
	if (encoding !== "utf8" && encoding !== "base64") {
		return `A file reference's "encoding" is "utf8" (text, the default) or "base64" (binary), not ${JSON.stringify(encoding)}.`;
	}
	const text = written.trim();
	let source: ParsedRef["source"];
	let name = text;
	if (text.startsWith(DATA_PREFIX)) {
		source = "attachment";
		name = text.slice(DATA_PREFIX.length);
	} else if (text.startsWith(OUTPUT_PREFIX)) {
		source = "output";
		name = text.slice(OUTPUT_PREFIX.length);
	} else if (text.startsWith("/")) {
		return `File reference "${text}" is outside the conversation's files. Use "${DATA_PREFIX}<name>" for an attachment or "${OUTPUT_PREFIX}<name>" for a file you produced.`;
	}
	if (!name || name.split("/").some((part) => part === ".." || part === "." || part === "")) {
		return `File reference "${text}" is not a valid file path. Use "${DATA_PREFIX}<name>" for an attachment or "${OUTPUT_PREFIX}<name>" for a file you produced.`;
	}
	return { written: text, name, source, encoding };
}

/** The reference as the card and the logs say it: the name and encoding, never the content. */
export function describeFileRef(ref: Record<string, unknown>): string {
	const name = typeof ref[FILE_REF_KEY] === "string" ? ref[FILE_REF_KEY] : "?";
	return ref.encoding === "base64" ? `${name} (base64)` : name;
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Found = Extract<ConversationFile, { ok: true }>;

/** The explicit path a file answers to, as the model is shown it. */
function pathOf(source: "attachment" | "output", name: string): string {
	return `${source === "attachment" ? DATA_PREFIX : OUTPUT_PREFIX}${name}`;
}

function sizeText(file: Found): string {
	return `${file.bytes.length.toLocaleString("en-US")} bytes`;
}

type Picked =
	{ ok: true; file: Found; source: "attachment" | "output" } | { ok: false; error: string };

/** The file a reference names: by its root when it has one, else the only file that has the name. */
async function pickFile(
	parsed: ParsedRef,
	conversationId: ObjectId,
	branch: ReadonlySet<string> | undefined,
	lookup: LookupFile
): Promise<Picked> {
	const options = (source: "attachment" | "output") => ({ source, ...(branch ? { branch } : {}) });
	if (parsed.source) {
		const file = await lookup(conversationId, parsed.name, options(parsed.source));
		if (!file.ok) return { ok: false, error: `File reference "${parsed.written}": ${file.error}` };
		return { ok: true, file, source: parsed.source };
	}
	const attachment = await lookup(conversationId, parsed.name, options("attachment"));
	const output = await lookup(conversationId, parsed.name, options("output"));
	if (attachment.ok && output.ok) {
		if (attachment.sha256 === output.sha256)
			return { ok: true, file: attachment, source: "attachment" };
		return {
			ok: false,
			error:
				`File reference "${parsed.written}" is ambiguous: two different files have that name. Nothing was sent. ` +
				`Use the explicit path of the one you mean: ` +
				`"${pathOf("attachment", parsed.name)}" (the user's attachment, ${sizeText(attachment)}) or ` +
				`"${pathOf("output", parsed.name)}" (a file produced in this conversation, ${sizeText(output)}).`,
		};
	}
	if (attachment.ok) return { ok: true, file: attachment, source: "attachment" };
	if (output.ok) return { ok: true, file: output, source: "output" };
	// Neither: a privacy rule's own refusal outranks "no such file".
	const error = /^No file named/.test(attachment.error) ? output.error : attachment.error;
	return { ok: false, error: `File reference "${parsed.written}": ${error}` };
}

/**
 * Resolve every `{"$file": ...}` in `args` to the content of that file of the conversation.
 * Only this conversation's files (and, with a message id, only this branch's) can be named; a file a
 * privacy rule withheld answers with the rule's own refusal, never its bytes. Any problem returns an
 * error for the model and nothing is sent to the connector.
 */
export async function resolveFileReferences(
	args: Record<string, unknown>,
	ctx: FileRefContext | undefined,
	lookup: LookupFile = findConversationFile
): Promise<FileRefResult> {
	const stringified = findStringifiedRef(args);
	if (stringified) {
		return {
			ok: false,
			error: `The argument "${stringified}" is a string that contains a file reference as text. Nothing was sent, because the text itself would have been used as the content. Pass the reference as a JSON object, not a string: "${stringified}": {"$file": "${DATA_PREFIX}<name>"}.`,
		};
	}
	const refs = collectRefs(args);
	if (refs.length === 0) return { ok: true, args, resolved: 0, notes: [] };
	if (!ctx) {
		return {
			ok: false,
			error:
				"File references can only be used inside a conversation; pass the content inline instead.",
		};
	}

	const branch = await branchOf(ctx.conversationId, ctx.messageId);
	const contents = new Map<Record<string, unknown>, string>();
	const notes: string[] = [];
	const cache = new Map<string, { content: string; note: string }>();
	let total = 0;
	for (const { ref, at } of refs) {
		const parsed = parseRef(ref);
		if (typeof parsed === "string") return { ok: false, error: parsed };
		const { encoding } = parsed;
		const key = `${encoding}:${parsed.written}`;
		let hit = cache.get(key);
		if (hit === undefined) {
			const picked = await pickFile(parsed, ctx.conversationId, branch, lookup);
			if (!picked.ok) return { ok: false, error: picked.error };
			const { file, source } = picked;
			const shown = pathOf(source, parsed.name);
			if (file.bytes.length > MAX_FILE_REF_BYTES) {
				return {
					ok: false,
					error: `File reference "${shown}" is ${megabytes(file.bytes.length)}, over the ${megabytes(MAX_FILE_REF_BYTES)} limit for one file. Nothing was sent.`,
				};
			}
			let content: string;
			if (encoding === "base64") {
				content = file.bytes.toString("base64");
			} else {
				try {
					content = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
				} catch {
					return {
						ok: false,
						error: `File reference "${shown}" is not UTF-8 text. For binary content use {"$file": "${shown}", "encoding": "base64"}.`,
					};
				}
			}
			const label = source === "attachment" ? "attachment" : "produced file";
			hit = {
				content,
				note: `${shown} (${label}, ${sizeText(file)}, sha256 ${file.sha256.slice(0, 8)}…)`,
			};
			cache.set(key, hit);
		}
		total += hit.content.length;
		if (total > MAX_FILE_REF_TOTAL_BYTES) {
			return {
				ok: false,
				error: `The file references of this call add up to more than ${megabytes(MAX_FILE_REF_TOTAL_BYTES)}. Nothing was sent; split the work across several calls.`,
			};
		}
		contents.set(ref, hit.content);
		notes.push(`[file reference] ${at} ← ${hit.note}`);
	}

	const swap = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(swap);
		if (isRefObject(node)) return contents.get(node) ?? node;
		if (node && typeof node === "object") {
			return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, swap(v)]));
		}
		return node;
	};
	return { ok: true, args: swap(args) as Record<string, unknown>, resolved: refs.length, notes };
}

/** The tool's own text with the notes appended, for the model to read. */
export function withFileRefNotes(text: string, notes: readonly string[]): string {
	return notes.length
		? `${text}${text && !text.endsWith("\n") ? "\n" : ""}${notes.join("\n")}`
		: text;
}
