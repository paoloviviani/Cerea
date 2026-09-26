import type { ObjectId } from "mongodb";
import type { Conversation } from "./Conversation";
import type { Message } from "./Message";
import type { PersistedDeliverableRef } from "./ParkedCall";

/**
 * The output files of one browser-started run — a chat code block (auto-run
 * or Run) or an artifact cell — attached to the assistant message its code
 * belongs to.
 *
 * Its own collection rather than an update pushed onto the message, because
 * a turn persists `messages` wholesale: a record pushed while that message's
 * turn was still streaming (an auto-run fires as soon as the fence closes)
 * would be overwritten by the turn's next save. The conversation loader
 * merges these into the messages it serves as `CodeExecution/Outputs`
 * updates, so everything downstream sees one shape.
 *
 * The bytes are in the deliverable store (`codeExecutionOutputs`); this only
 * names them. Same 30-day retention, and deleted with the conversation.
 */
export interface CodeRunFiles {
	_id: ObjectId;
	conversationId: Conversation["_id"];
	messageId: Message["id"];
	/** `chatRunKey` / `artifactRunKey` of the run, so a replayed block finds its own files. */
	runKey: string;
	/** The run's files, in the order it listed them; each rebuilt from a store row. */
	files: PersistedDeliverableRef[];
	/** The files' hashes joined: one record per distinct output of a run. */
	fingerprint: string;
	createdAt: Date;
}
