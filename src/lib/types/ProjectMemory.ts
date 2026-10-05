import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * One note a project's members keep for the project, carried into every
 * conversation in it.
 *
 * It is the personal `Memory` list (read `$lib/types/Memory` for why that is a
 * list injected whole rather than a store searched) moved from a person to a
 * project: same shape, same budget rule, same tools. The differences are the
 * ones sharing forces.
 *
 * ## Who may touch it
 *
 * Everyone who can see the project — its owner and everyone it is shared with
 * — can read, add, edit and delete notes. That is wider than the project's
 * instructions, which only the owner changes, and deliberately so: a note is
 * something a colleague learned that the next colleague should not have to
 * relearn, and routing each one through the owner would end the habit of
 * writing them. The cost is that any member can write into every member's
 * prompt in that project, which is why each note keeps its author and the
 * block is only ever built for that project's own chats.
 *
 * ## What happens to the author
 *
 * `authorUserId` is who is accountable for the note — for `source: "model"`,
 * the person whose turn the model wrote it in. Erasing an account deletes the
 * notes in projects that person owns (they go with the project) and leaves
 * the rest, which then show their author as "deleted user": the note is the
 * project's knowledge by then, not the author's data.
 */
export interface ProjectMemory extends Timestamps {
	_id: ObjectId;

	/** The project the note belongs to; deleting the project deletes its notes. */
	projectId: ObjectId;

	/** The note itself. */
	text: string;

	/** `model` came from a `remember_for_project` call; `user` was typed in the tab. */
	source: "model" | "user";

	/** Who wrote it, or in whose turn the model did. */
	authorUserId: User["_id"];

	/** The chat a `model`-written note came from, when there was one. */
	conversationId?: ObjectId;
}

/** A project note as the browser sees it. */
export interface ProjectMemoryView {
	id: string;
	text: string;
	source: "model" | "user";
	/** A display name, or "deleted user" once the account is gone. */
	author: string;
	/** Whether the viewer wrote it — the tab words this "you". */
	mine: boolean;
	conversationId?: string;
	createdAt: string;
	updatedAt: string;
}
