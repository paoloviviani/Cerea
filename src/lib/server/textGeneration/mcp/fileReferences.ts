import type { ObjectId } from "mongodb";
import { branchOf } from "$lib/server/execution/fileVersions";
import { findConversationFile, type ConversationFile } from "../builtinTools/conversationFiles";

/**
 * File references in connector (MCP) tool arguments.
 *
 * The sandbox has no network, so a file the model made (or the person attached) cannot be sent to a
 * connector by code. Inlining it into the call's arguments costs the model's output budget (a few
 * hundred KB of SVG or base64 ends in a cut-off call). Instead the model writes a reference where a
 * string argument goes:
 *
 *     {"$file": "diagram.svg"}                         the file's text (UTF-8)
 *     {"$file": "logo.png", "encoding": "base64"}      the file's bytes as base64
 *
 * and the server swaps in the content just before the call. An object with a `$file` key is the only
 * thing that is ever rewritten: a plain string (even one that looks like a file name) is never
 * touched, which is why this is an object form and not a `file:<name>` string form.
 *
 * The call as the model made it (references, not bytes) is what the approval card, the stored
 * message and the logs keep: `resolveFileReferences` returns a copy and never mutates its input.
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
	{ ok: true; args: Record<string, unknown>; resolved: number } | { ok: false; error: string };

type LookupFile = (
	conversationId: ObjectId,
	name: string,
	options: { branch?: ReadonlySet<string> }
) => Promise<ConversationFile>;

function isRefObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.prototype.hasOwnProperty.call(value, FILE_REF_KEY)
	);
}

/** Every reference in the arguments, depth first. */
function collectRefs(
	node: unknown,
	found: Record<string, unknown>[] = []
): Record<string, unknown>[] {
	if (Array.isArray(node)) {
		for (const item of node) collectRefs(item, found);
	} else if (isRefObject(node)) {
		found.push(node);
	} else if (node && typeof node === "object") {
		for (const value of Object.values(node)) collectRefs(value, found);
	}
	return found;
}

/** True when the arguments hold at least one `{"$file": ...}` reference. */
export function hasFileRefs(args: unknown): boolean {
	return collectRefs(args).length > 0;
}

function parseRef(
	ref: Record<string, unknown>
): { name: string; encoding: FileRefEncoding } | string {
	const name = ref[FILE_REF_KEY];
	if (typeof name !== "string" || !name.trim()) {
		return `A file reference needs the file's name: {"$file": "<name>"}.`;
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
	return { name: name.trim(), encoding };
}

/** The reference as the card and the logs say it: the name and encoding, never the content. */
export function describeFileRef(ref: Record<string, unknown>): string {
	const name = typeof ref[FILE_REF_KEY] === "string" ? ref[FILE_REF_KEY] : "?";
	return ref.encoding === "base64" ? `${name} (base64)` : name;
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
	const refs = collectRefs(args);
	if (refs.length === 0) return { ok: true, args, resolved: 0 };
	if (!ctx) {
		return {
			ok: false,
			error:
				"File references can only be used inside a conversation; pass the content inline instead.",
		};
	}

	const branch = await branchOf(ctx.conversationId, ctx.messageId);
	const contents = new Map<Record<string, unknown>, string>();
	const cache = new Map<string, string>();
	let total = 0;
	for (const ref of refs) {
		const parsed = parseRef(ref);
		if (typeof parsed === "string") return { ok: false, error: parsed };
		const { name, encoding } = parsed;
		const key = `${encoding}:${name}`;
		let content = cache.get(key);
		if (content === undefined) {
			const file = await lookup(ctx.conversationId, name, { ...(branch ? { branch } : {}) });
			if (!file.ok) return { ok: false, error: `File reference "${name}": ${file.error}` };
			if (file.bytes.length > MAX_FILE_REF_BYTES) {
				return {
					ok: false,
					error: `File reference "${file.name}" is ${megabytes(file.bytes.length)}, over the ${megabytes(MAX_FILE_REF_BYTES)} limit for one file. Nothing was sent.`,
				};
			}
			if (encoding === "base64") {
				content = file.bytes.toString("base64");
			} else {
				try {
					content = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
				} catch {
					return {
						ok: false,
						error: `File reference "${file.name}" is not UTF-8 text. For binary content use {"$file": "${file.name}", "encoding": "base64"}.`,
					};
				}
			}
			cache.set(key, content);
		}
		total += content.length;
		if (total > MAX_FILE_REF_TOTAL_BYTES) {
			return {
				ok: false,
				error: `The file references of this call add up to more than ${megabytes(MAX_FILE_REF_TOTAL_BYTES)}. Nothing was sent; split the work across several calls.`,
			};
		}
		contents.set(ref, content);
	}

	const swap = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(swap);
		if (isRefObject(node)) return contents.get(node) ?? node;
		if (node && typeof node === "object") {
			return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, swap(v)]));
		}
		return node;
	};
	return { ok: true, args: swap(args) as Record<string, unknown>, resolved: refs.length };
}
