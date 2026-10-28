import { collections } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import type { MessageFile } from "$lib/types/Message";
import { planAttachments, type PlannedAttachment } from "$lib/utils/execution/attachmentNames";

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
	return planned ? { planned, at: conversation?.createdAt ?? new Date(0) } : undefined;
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
		const offset = (await attachmentNamed(conversationId, name)) ? 1 : 0;
		const taken = new Set(rows.flatMap((row) => (row.version === undefined ? [] : [row.version])));
		let next = offset + 1;
		for (const row of missing) {
			while (taken.has(next)) next += 1;
			row.version = next;
			taken.add(next);
			await collections.codeExecutionOutputs.updateOne(
				{ _id: row._id, version: { $exists: false } },
				{ $set: { version: next } }
			);
		}
	}
	return rows.sort(
		(a, b) => (a.version ?? 0) - (b.version ?? 0) || a.createdAt.getTime() - b.createdAt.getTime()
	);
}

/** The next version number of a name: one past the highest stored, or 2 after an attachment, else 1. */
export async function nextVersionNumber(
	conversationId: Conversation["_id"],
	name: string
): Promise<number> {
	const rows = await numberedRows(conversationId, name);
	if (rows.length > 0) return Math.max(...rows.map((row) => row.version ?? 0)) + 1;
	return (await attachmentNamed(conversationId, name)) ? 2 : 1;
}
