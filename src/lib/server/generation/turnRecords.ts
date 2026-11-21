/**
 * The records a turn leaves under (conversation id, assistant message id): its event log,
 * its run, its state and any parked call. Message ids are chosen by the client (C156), so an
 * id must not be reused while any of these still names it.
 */
import { collections } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";

export async function messageIdHasTurnRecords(
	conversationId: Conversation["_id"],
	messageId: string
): Promise<boolean> {
	const key = { conversationId, messageId };
	const found = await Promise.all([
		collections.generations.findOne(key, { projection: { _id: 1 } }),
		collections.generationEvents.findOne(key, { projection: { _id: 1 } }),
		collections.turnStates.findOne(key, { projection: { _id: 1 } }),
		collections.parkedCalls.findOne(key, { projection: { _id: 1 } }),
	]);
	return found.some(Boolean);
}

/** A deleted conversation takes its turn records with it. */
export async function deleteTurnRecords(
	conversationId: Conversation["_id"] | Conversation["_id"][]
): Promise<void> {
	const filter = {
		conversationId: Array.isArray(conversationId) ? { $in: conversationId } : conversationId,
	};
	await Promise.all([
		collections.generations.deleteMany(filter),
		collections.generationEvents.deleteMany(filter),
		collections.turnStates.deleteMany(filter),
		collections.parkedCalls.deleteMany(filter),
	]);
}
