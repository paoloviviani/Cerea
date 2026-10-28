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
	/**
	 * Set when a tool made this file from another one of the conversation (a
	 * `doc_edit` result): the source's content hash and name. The source is
	 * never changed; this is the link between the two versions.
	 */
	derivedFromSha256?: string;
	derivedFromName?: string;
	/**
	 * Its number among the versions of its name (an attachment of that name is 1),
	 * fixed when the row is made so that expiring older rows never renumbers it.
	 * Absent on rows from before it was stored: `numberedRows` fills it in.
	 */
	version?: number;
	/** The tool that made it ("doc_edit", "doc_create"...); absent for a sandbox run's file. */
	tool?: string;
	/** One line on what it is, for the version list ("replace_text x2; from version 1"). */
	summary?: string;
	/**
	 * Set when an older version was made the current one again (a restore):
	 * the file is keyed by content, so the row is not copied, it is marked.
	 * The current version of a name is the row with the latest `latestAt ?? createdAt`.
	 */
	latestAt?: Date;
	createdAt: Date;
}
