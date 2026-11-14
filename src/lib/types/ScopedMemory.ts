import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * A narrower list beside personal (`Memory`) and project (`ProjectMemory`)
 * memory: notes that belong to one chat. It is the same machine as the other
 * two (see `$lib/types/Memory`: a short list, injected whole, never searched)
 * pointed at a smaller key, because the failure it exists to fix is writing
 * too broadly: "remember this for this chat" must not become a fact in every
 * future chat. A note that is too narrow is forgotten at the end of the chat;
 * a note that is too wide is repeated for ever.
 *
 * ## Chat notes (`ConversationMemory`)
 *
 * Keyed by the conversation. Access is the conversation's own: whoever can
 * open the chat can read and edit its notes, and nobody else can. Deleting
 * the chat deletes them (`deleteConversationStorage`).
 */
export interface ConversationMemory extends Timestamps {
	_id: ObjectId;
	/** The chat the note belongs to. */
	conversationId: ObjectId;
	/** The chat's owner at the time, when it has one (an anonymous chat has none). */
	userId?: User["_id"];
	text: string;
	/** `model` came from a `remember` call during a turn; `user` was typed in the Notes list. */
	source: "model" | "user";
}

export interface ConversationMemoryView {
	id: string;
	text: string;
	source: "model" | "user";
	createdAt: string;
	updatedAt: string;
}

/** A chat note is a sentence or two: the caps keep one chat from crowding every turn of it. */
export const CONVERSATION_MEMORY_TEXT_MAX_CHARS = 1000;
export const CONVERSATION_MEMORY_MAX_NOTES = 50;
export const CONVERSATION_MEMORY_BLOCK_MAX_CHARS = 3000;
