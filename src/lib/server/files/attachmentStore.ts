/**
 * The owner-keyed attachment store: chat's file storage, for surfaces that
 * have no conversation.
 *
 * A coding-agent session (or any other surface) that wants what a person
 * sent it to still render after a reload stores it here. There is no second
 * store — this is the same GridFS bucket, the same writer (`writeAttachment`,
 * which `uploadFile` also goes through), the same `<owner>-<sha>` naming and
 * the same `metadata.conversation` ownership tag that `downloadFile` checks.
 * The only difference is what goes in the tag: a namespaced **owner key**
 * (`code:<deviceId>:<sessionId>`) instead of a conversation id, plus the
 * `messageId` the file was sent with.
 *
 * Owner keys must carry a namespace (`<surface>:…`). A conversation id is 24
 * hex digits and never contains a colon, so a key accepted here can never
 * name — and so never read, overwrite or delete — a chat conversation's
 * files, and chat's own routes (which parse their id as an ObjectId) can
 * never reach an owner-keyed entry.
 *
 * This module knows nothing about devices or agents: authorizing a key for a
 * caller is the surface's job (`codeAttachments.ts` for `/code`).
 */

import { ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { ExtractionFailureKind, MessageFile } from "$lib/types/Message";
import { downloadFile } from "./downloadFile";
import { writeAttachment } from "./uploadFile";

/** `<surface>:<rest>`, where the surface is a lowercase word and the rest is id-safe. */
const OWNER_KEY = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.:~-]{1,256}$/;
const MESSAGE_ID = /^[A-Za-z0-9_.:~-]{1,128}$/;

export function isOwnerKey(key: string): boolean {
	return OWNER_KEY.test(key);
}

function assertOwnerKey(key: string): void {
	if (!isOwnerKey(key)) throw new Error(`Not a namespaced attachment owner key: ${key}`);
}

function assertMessageId(messageId: string): void {
	if (!MESSAGE_ID.test(messageId)) throw new Error(`Not a valid attachment message id`);
}

/**
 * Store one file sent with one message, extracting a document's text exactly
 * as chat does. Returns the `MessageFile` (type `hash`) the surface keeps.
 *
 * `token` is the caller's gateway token: extraction runs as the person who
 * attached the document, billed to them, like chat.
 */
export async function storeAttachment(
	file: File,
	ownerKey: string,
	messageId: string,
	token?: string
): Promise<MessageFile> {
	assertOwnerKey(ownerKey);
	assertMessageId(messageId);
	return writeAttachment(file, ownerKey, token, { messageId });
}

interface StoredMetadata {
	conversation: string;
	mime?: string;
	messageId?: string;
	sha?: string;
	name?: string;
	declaredMime?: string;
	extractedFrom?: string;
	pages?: number;
	extractionKind?: ExtractionFailureKind;
	extractionReason?: string;
}

/**
 * The `MessageFile`s sent with one message, in the order they were stored —
 * what `storeAttachment` returned for them, rebuilt from the bucket alone.
 * An extracted-text entry is folded into its document's `extracted` rather
 * than listed on its own, as it is in chat's messages.
 */
export async function findAttachments(ownerKey: string, messageId: string): Promise<MessageFile[]> {
	assertOwnerKey(ownerKey);
	assertMessageId(messageId);
	const rows = await collections.bucket
		.find({ "metadata.conversation": ownerKey, "metadata.messageId": messageId })
		.sort({ uploadDate: 1, _id: 1 })
		.toArray();

	const texts = new Map<string, { value: string; pages: number }>();
	for (const row of rows) {
		const meta = row.metadata as StoredMetadata | undefined;
		if (meta?.extractedFrom && meta.sha) {
			texts.set(meta.extractedFrom, { value: meta.sha, pages: meta.pages ?? 0 });
		}
	}

	const files: MessageFile[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const meta = row.metadata as StoredMetadata | undefined;
		if (!meta?.sha || meta.extractedFrom) continue;
		// The same file attached twice to one message is one attachment.
		if (seen.has(meta.sha)) continue;
		seen.add(meta.sha);
		const extracted = texts.get(meta.sha);
		files.push({
			type: "hash",
			value: meta.sha,
			mime: meta.mime ?? meta.declaredMime ?? "application/octet-stream",
			name: meta.name ?? meta.sha,
			...(extracted ? { extracted } : {}),
			...(!extracted && meta.extractionKind && meta.extractionReason
				? { extractionError: { kind: meta.extractionKind, reason: meta.extractionReason } }
				: {}),
		});
	}
	return files;
}

/**
 * The bytes of one stored file, as base64 — for a surface's transport that
 * has to hand the file on (to an agent, say). 404s through `downloadFile`
 * when the key does not own that sha.
 */
export async function readAttachment(sha256: string, ownerKey: string) {
	assertOwnerKey(ownerKey);
	return downloadFile(sha256, ownerKey);
}

async function deleteMatching(filter: Record<string, unknown>): Promise<number> {
	const files = await collections.bucket
		.find(filter)
		.project<{ _id: ObjectId }>({ _id: 1 })
		.toArray();
	// As `deleteConversationAttachments`: `bucket.delete` removes chunks too,
	// and one failure must not strand the rest.
	const results = await Promise.all(
		files.map((file) =>
			collections.bucket.delete(file._id).then(
				() => true,
				(err) => {
					logger.error(
						{ err, fileId: file._id.toString() },
						"failed to delete owner-keyed attachment bytes"
					);
					return false;
				}
			)
		)
	);
	return results.filter(Boolean).length;
}

/** Delete every file stored under one owner key (one agent session). */
export async function deleteAttachments(ownerKey: string): Promise<number> {
	assertOwnerKey(ownerKey);
	return deleteMatching({ "metadata.conversation": ownerKey });
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Delete every file whose owner key starts with `prefix` — everything one
 * device's sessions stored, on revoke (`code:<deviceId>:`).
 *
 * The prefix must itself be namespaced and end at a separator, so
 * `code:abc` can never also match `code:abcdef:…`, and no prefix can reach a
 * chat conversation's files (whose tags carry no colon). Matching is on
 * `metadata.conversation`, never the filename, for the reason
 * `deleteConversationAttachments` gives.
 */
export async function deleteAttachmentsByPrefix(prefix: string): Promise<number> {
	if (!/^[a-z][a-z0-9-]{0,31}:([A-Za-z0-9_.~-]+:)*$/.test(prefix)) {
		throw new Error(`Not a namespaced owner-key prefix ending in ":": ${prefix}`);
	}
	return deleteMatching({ "metadata.conversation": { $regex: `^${escapeRegExp(prefix)}` } });
}
