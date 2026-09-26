import type { Conversation } from "./Conversation";
import type { User } from "./User";

export type SharedConversation = Pick<
	Conversation,
	"model" | "title" | "rootMessageId" | "messages" | "preprompt" | "createdAt" | "updatedAt"
> & {
	_id: string;
	hash: string;
	/**
	 * Who made the link (ADR 0093 deviation — see the worker's report). The
	 * design's §7.2/§9.2 name `sharedConversations` as reassigned on merge and
	 * deleted on erasure, but nothing in the shape it started from traced a
	 * share back to its creator: `_id` is a fresh nanoid, not the source
	 * conversation's, and `Conversation` itself keeps no reverse link either.
	 * Added so the registry (`userKeyedCollections.ts`) can actually find
	 * "this person's shared links"; absent on links created before this
	 * field existed, which the registry's merge and erasure then simply
	 * cannot reach — a gap flagged for the design to confirm, not silently
	 * left unfixed.
	 */
	userId?: User["_id"];
};
