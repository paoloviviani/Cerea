import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * Two narrower lists beside personal (`Memory`) and project (`ProjectMemory`)
 * memory: notes that belong to one chat, and notes a coding agent keeps for
 * one session or one workspace. They are the same machine as the other two
 * (see `$lib/types/Memory`: a short list, injected whole, never searched)
 * pointed at a smaller key, because the failure they exist to fix is writing
 * too broadly: "remember this for this chat" must not become a fact in every
 * future chat. A note that is too narrow is forgotten at the end of the chat;
 * a note that is too wide is repeated for ever.
 *
 * ## Chat notes (`ConversationMemory`)
 *
 * Keyed by the conversation. Access is the conversation's own: whoever can
 * open the chat can read and edit its notes, and nobody else can. Deleting
 * the chat deletes them (`deleteConversationStorage`).
 *
 * ## Agent notes (`AgentMemory`)
 *
 * Written by a coding agent through galopin's `memory_*` tools, over the
 * machine link. Two scopes only: `session` (one agent session, surviving
 * opencode's compaction and restarts of that session) and `workspace` (one
 * folder on one computer, shared by every session in it). There is no
 * personal, project or chat scope for an agent, in either direction: the
 * machine-call handler refuses them by the caller's kind, and these rows live
 * in their own collection that the chat's memory code never reads.
 *
 * Agent notes are **untrusted input**. An agent that has read hostile code
 * may write anything into one. They are shown to their owner as notes, in the
 * code panel, and are never read by a chat turn.
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

export type AgentMemoryScope = "session" | "workspace";

export interface AgentMemory extends Timestamps {
	_id: ObjectId;
	/** The device's owner: every read and write is matched on it. */
	userId: User["_id"];
	/** The paired computer, as its hex id. A note never crosses computers. */
	deviceId: string;
	scope: AgentMemoryScope;
	/** The session id (scope `session`) or the workspace id (scope `workspace`) on that computer. */
	key: string;
	text: string;
	/** `model` was written by the agent; `user` was typed in the code panel. */
	source: "model" | "user";
}

export interface AgentMemoryView {
	id: string;
	text: string;
	source: "model" | "user";
	createdAt: string;
	updatedAt: string;
}

export const AGENT_MEMORY_TEXT_MAX_CHARS = 1000;
export const AGENT_MEMORY_MAX_NOTES = 50;
export const AGENT_MEMORY_BLOCK_MAX_CHARS = 4000;
