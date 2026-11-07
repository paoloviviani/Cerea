/**
 * A first send that died before a single word came back (a spent quota, a
 * provider error) leaves a chat holding the user's message and a failed,
 * empty reply. Retrying from the new-chat page would stack another chat
 * beside it, and the failed ones read as the same title nine times over.
 *
 * Creating a chat removes this owner's failed first chats first, so one
 * failed attempt never becomes two. A chat the user went on with (any reply
 * with text, a rename, more than one exchange) is never touched, and neither
 * is one still generating: it has no error yet. Project chats are left alone,
 * and so is a chat whose message carries files: an upload is the user's work
 * and stays until they delete it.
 */
import type { Filter } from "mongodb";
import { collections } from "$lib/server/database";
import { deleteConversationStorage } from "$lib/server/conversationStorage";
import type { Conversation } from "$lib/types/Conversation";
import type { Message } from "$lib/types/Message";
import { MessageUpdateStatus, MessageUpdateType } from "$lib/types/MessageUpdate";

/** Older failed chats are the user's to keep or delete. */
const ABANDONED_WINDOW_MS = 24 * 60 * 60 * 1000;

function failedWithoutText(message: Message | undefined): boolean {
	if (!message || message.from !== "assistant" || message.content?.trim()) return false;
	return (message.updates ?? []).some(
		(u) =>
			(u.type === MessageUpdateType.Status && u.status === MessageUpdateStatus.Error) ||
			(u.type === MessageUpdateType.TurnState && u.state === "failed")
	);
}

/** Whether this conversation is a first exchange that failed with no reply text. */
export function isAbandonedFirstChat(
	conv: Pick<Conversation, "messages" | "titleSource">
): boolean {
	if (conv.titleSource === "user") return false;
	const messages = conv.messages ?? [];
	const exchange = messages.filter((m) => m.from !== "system");
	return (
		exchange.length === 2 &&
		exchange[0].from === "user" &&
		!(exchange[0].files?.length ?? 0) &&
		failedWithoutText(exchange[1])
	);
}

/** Delete the owner's failed first chats; returns their ids so the client can drop them. */
export async function removeAbandonedFirstChats(
	owner: Filter<Conversation>,
	now = new Date()
): Promise<string[]> {
	const candidates = await collections.conversations
		.find({
			...owner,
			createdAt: { $gt: new Date(now.getTime() - ABANDONED_WINDOW_MS) },
			titleSource: { $ne: "user" },
			projectId: { $exists: false },
			"messages.1": { $exists: true },
			"messages.3": { $exists: false },
		})
		.project<Pick<Conversation, "_id" | "messages" | "titleSource">>({
			messages: 1,
			titleSource: 1,
		})
		.toArray();
	const removed: string[] = [];
	for (const conv of candidates) {
		if (!isAbandonedFirstChat(conv)) continue;
		await collections.conversations.deleteOne({ _id: conv._id });
		await deleteConversationStorage(conv._id);
		removed.push(conv._id.toString());
	}
	return removed;
}
