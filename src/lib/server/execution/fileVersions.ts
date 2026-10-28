import { collections } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import type { MessageFile } from "$lib/types/Message";
import { planAttachments, type PlannedAttachment } from "$lib/utils/execution/attachmentNames";

/** Mongo's duplicate-key error: a unique index refused the write. */
export function isDuplicateKeyError(err: unknown): boolean {
	return (err as { code?: number } | null | undefined)?.code === 11000;
}

/** The attachment of a conversation a name stands for, if there is one, and when it was sent. */
export async function attachmentNamed(
	conversationId: Conversation["_id"],
	wanted: string
): Promise<{ planned: PlannedAttachment; at: Date } | undefined> {
	const conversation = await collections.conversations.findOne(
		{ _id: conversationId },
		{ projection: { messages: 1, createdAt: 1 } }
	);
	const files: MessageFile[] = (conversation?.messages ?? []).flatMap(
		(message) => message.files ?? []
	);
	const planned = planAttachments(files).find(
		(entry) => entry.file.type === "hash" && (entry.name === wanted || entry.file.name === wanted)
	);
	if (!planned) return undefined;
	// When it was sent: the timestamp of the message that carries it (`files`
	// keeps the message's own file object, so the match is by reference), the
	// conversation's when the message carries none — the old reading, which
	// keeps a message without a timestamp no newer than the produced rows.
	const message = (conversation?.messages ?? []).find((sent) =>
		(sent.files ?? []).some((file) => file === planned.file)
	);
	return { planned, at: message?.createdAt ?? conversation?.createdAt ?? new Date(0) };
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
