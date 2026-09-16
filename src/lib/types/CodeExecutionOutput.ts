import type { ObjectId } from "mongodb";
import type { Conversation } from "./Conversation";
import type { User } from "./User";

/**
 * One deliverable an `execute_code` tool run surfaced as output, persisted
 * per-user for 30 days (ADR 0073's 2026-09-16 amendment) so a download card
 * survives a reload and works from another device — the same trust model as
 * a message attachment, not a new one.
 *
 * Bytes live in the `codeOutputs` GridFS bucket (`collections.codeOutputBucket`),
 * keyed by `gridFsId`; this row is the access-checked index over them (by
 * conversation + content hash, for dedup and lookup) and the TTL anchor.
 * Deleting a conversation deletes its rows and bytes together
 * (`deleteConversationDeliverables`); the TTL index here is the 30-day
 * backstop for conversations that are never deleted.
 */
export interface CodeExecutionOutput {
	_id: ObjectId;
	conversationId: Conversation["_id"];
	/** Absent for a session-only (sessionId-based) chat, like other per-user rows. */
	userId?: User["_id"];
	/** SHA-256 of the raw bytes, computed server-side — never trusted from the client. */
	sha256: string;
	name: string;
	mime: string;
	size: number;
	/** Id of the GridFS file in the `codeOutputs` bucket carrying the bytes. */
	gridFsId: ObjectId;
	createdAt: Date;
}
