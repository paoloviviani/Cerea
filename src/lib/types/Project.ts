import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * A group of conversations that share standing context.
 *
 * Projects live here and not in the gateway, and the split is deliberate
 * (ADR 0062): a project is a way of organising *conversations*, and
 * conversations are this application's, in its own database. The knowledge
 * pipeline moved in here with ADR 0070 as well — bases, documents, vectors —
 * so a project names them the same way everything else in the chat does, by
 * this application's own store id rather than a copy of somebody else's.
 *
 * ## Sharing without an admin surface
 *
 * A project may be shared with a person by email address or with a group by
 * name, and access is decided **against the viewer's own identity**: their
 * email, and the groups `GET /v1/billing/groups` reports for them. Nothing
 * here asks the gateway "who is in group X" — there is no such route under a
 * bearer token, and adding one would mean a chat client could enumerate a
 * deployment's directory. Reading the answer from the viewer's own token is
 * both sufficient and unprivileged.
 *
 * What that costs, stated because it will otherwise be mistaken for a bug: a
 * share names a principal that may not exist. A typo'd address is
 * indistinguishable from a colleague who has not signed in yet, and both look
 * the same until somebody with that address opens the project. The owner sees
 * the list of shares they wrote, never a list of people it resolved to.
 *
 * ## Sharing a project does not share its knowledge bases
 *
 * Retrieval re-checks the *viewer's* access to every attached base on every
 * turn. Somebody a project is shared with sees
 * passages only from bases they could already read, and the project page says
 * so. That is what stops a project being a way to publish a document without
 * sharing the document.
 */
export interface Project extends Timestamps {
	_id: ObjectId;

	/** The owner. Only they may edit, share or delete it. */
	userId: User["_id"];

	name: string;
	description?: string;

	/**
	 * Standing context, prepended to the system prompt of every conversation in
	 * the project. Text only.
	 */
	instructions: string;

	/** This chat's knowledge base ids. Names, not copies: each base is its own
	 * thing, with its own owner and its own lifecycle. */
	knowledgeBaseIds: string[];

	/**
	 * The knowledge base holding this project's own past conversations,
	 * created on demand the first time `indexPastChats` is on and a turn
	 * finishes. Separate from `knowledgeBaseIds` because it is written by this
	 * application rather than by a person, and because turning the feature off
	 * should stop the retrieval without detaching a base somebody attached by
	 * hand.
	 */
	memoryBaseId?: string;

	/**
	 * Whether finished exchanges are indexed for retrieval in later
	 * conversations of the same project. Off by default: it copies what was
	 * said into a searchable store, and that is a decision worth making rather
	 * than discovering.
	 */
	indexPastChats: boolean;

	/** How many passages retrieval may put in front of the model per turn. */
	retrievalLimit: number;

	shares: ProjectShare[];
}

export type ProjectShare =
	| { kind: "user"; email: string; createdAt: Date }
	| { kind: "group"; name: string; createdAt: Date };

/** What the client is given. `_id` as a string, and no other shape change. */
export interface ProjectView {
	id: string;
	name: string;
	description: string;
	instructions: string;
	knowledgeBaseIds: string[];
	indexPastChats: boolean;
	retrievalLimit: number;
	/** Whether the viewer owns it. Editing, sharing and deleting need this. */
	owned: boolean;
	shares: { kind: "user" | "group"; principal: string }[];
	conversationCount: number;
	updatedAt: string;
}
