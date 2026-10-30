import type { ObjectId } from "bson";

export interface ConvSidebar {
	id: ObjectId | string;
	title: string;
	updatedAt: Date;
	model?: string;
	avatarUrl?: string | Promise<string | undefined>;
	/**
	 * The project it belongs to, if any. The sidebar tree shows a project's
	 * chats under the project, so the flat Chats branch excludes these —
	 * without it every project conversation would appear in both places.
	 */
	projectId?: string;
	/** A scheduled run answered in it and it has not been opened since. */
	unread?: true;
}
