import { collections } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import type { MessageFile } from "$lib/types/Message";
import { planAttachments, type PlannedAttachment } from "$lib/utils/execution/attachmentNames";

/** Mongo's duplicate-key error: a unique index refused the write. */
export function isDuplicateKeyError(err: unknown): boolean {
	return (err as { code?: number } | null | undefined)?.code === 11000;
}

/**
 * The message ids of one branch of the conversation tree: the message and its ancestors. A
 * conversation whose messages are edited and re-sent keeps both branches; a file version
 * counts on a turn only when the message that made it is on the turn's branch.
 */
export type Branch = ReadonlySet<string>;

/**
 * The branch a message belongs to (itself and its ancestors), or undefined when it cannot be
 * told (no message id, a legacy conversation with no tree, a message not saved yet): then
 * nothing is filtered, which is how a linear conversation always behaved.
 */
export async function branchOf(
	conversationId: Conversation["_id"],
	messageId: string | undefined
): Promise<Branch | undefined> {
	if (!messageId) return undefined;
	try {
		const conversation = await collections.conversations.findOne(
			{ _id: conversationId },
			{ projection: { messages: { $elemMatch: { id: messageId } } } }
		);
		const message = conversation?.messages?.[0];
		if (!message?.ancestors) return undefined;
		return new Set([...message.ancestors, message.id]);
	} catch {
		return undefined;
	}
}

/** Whether a stored version counts on a branch: no known producer, or a producer on the branch. */
export function onBranch(row: { messageIds?: string[] }, branch: Branch | undefined): boolean {
	if (!branch || !row.messageIds || row.messageIds.length === 0) return true;
	return row.messageIds.some((id) => branch.has(id));
}

/**
 * The attachment of a conversation a name stands for, if there is one, and
 * when it was sent: the NEWEST attachment of that name, so a re-uploaded file
 * — numbered at upload as a later version of the name — is the one the
 * version list and the tools see, not the superseded first upload.
 */
export async function attachmentNamed(
	conversationId: Conversation["_id"],
	wanted: string,
	branch?: Branch
): Promise<{ planned: PlannedAttachment; at: Date } | undefined> {
	const conversation = await collections.conversations.findOne(
		{ _id: conversationId },
		{ projection: { messages: 1, createdAt: 1 } }
	);
	// Only the messages of the branch send files to it: an attachment of another branch is not here.
	const messages = (conversation?.messages ?? []).filter(
		(message) => !branch || branch.has(message.id)
	);
	const fallback = conversation?.createdAt ?? new Date(0);
	// Each file knows when it was sent, so the same content attached again later is current
	// from its LAST sending (the plan keeps the one mount, with the latest time).
	const files: Array<MessageFile & { sentAt: number }> = messages.flatMap((message) =>
		(message.files ?? []).map((file) => ({
			...file,
			sentAt: (message.createdAt ?? fallback).getTime(),
		}))
	);
	// The plan lists files in message order, so the last match is the newest
	// (Array.findLast needs ES2023; this code compiles for ES2018).
	let planned: PlannedAttachment | undefined;
	for (const entry of planAttachments(files)) {
		if (entry.file.type === "hash" && (entry.name === wanted || entry.file.name === wanted))
			planned = entry;
	}
	if (!planned) return undefined;
	// When it was sent: the timestamp of the (last) message that carries it, the
	// conversation's when the message carries none — the old reading, which
	// keeps a message without a timestamp no newer than the produced rows.
	return { planned, at: new Date(planned.sentAt ?? fallback.getTime()) };
}

/**
 * Give every stored row of a name its version number, once. Rows made before
 * numbers were stored get theirs by position (attachment = 1, then the rows in
 * the order they were made) and keep it from then on, so deleting an old row
 * never renumbers a later one. Returns the rows in version order.
 */
export async function numberedRows(conversationId: Conversation["_id"], name: string) {
	const rows = await collections.codeExecutionOutputs
		.find({ conversationId, name })
		.sort({ createdAt: 1, _id: 1 })
		.toArray();
	const missing = rows.filter((row) => row.version === undefined);
	if (missing.length > 0) {
		const attachment = await attachmentNamed(conversationId, name);
		// The attachment of the name counts as taken, at the number it was given
		// at upload (1 when it carries none: the first version of its name).
		const taken = new Set(rows.flatMap((row) => (row.version === undefined ? [] : [row.version])));
		if (attachment) taken.add(attachment.planned.file.version ?? 1);
		let next = 1;
		for (const row of missing) {
			while (taken.has(next)) next += 1;
			row.version = next;
			taken.add(next);
			await collections.codeExecutionOutputs
				.updateOne({ _id: row._id, version: { $exists: false } }, { $set: { version: next } })
				.catch((err) => {
					// Another process numbering these same rows concurrently took the
					// number first (the unique index refused the write). The row keeps
					// no number; the next pass numbers it past the one that won.
					if (!isDuplicateKeyError(err)) throw err;
				});
		}
	}
	return rows.sort(
		(a, b) => (a.version ?? 0) - (b.version ?? 0) || a.createdAt.getTime() - b.createdAt.getTime()
	);
}

/**
 * The next version number of a name: one past the highest number taken — by a
 * stored row, or by the attachment of that name, which was given the next free
 * number at upload when the name already had versions.
 */
export async function nextVersionNumber(
	conversationId: Conversation["_id"],
	name: string
): Promise<number> {
	const rows = await numberedRows(conversationId, name);
	const attachment = await attachmentNamed(conversationId, name);
	let highest = attachment ? (attachment.planned.file.version ?? 1) : 0;
	for (const row of rows) highest = Math.max(highest, row.version ?? 0);
	return highest + 1;
}
