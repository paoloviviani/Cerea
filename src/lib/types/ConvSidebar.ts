import type { ObjectId } from "bson";

export interface ConvSidebar {
	id: ObjectId | string;
	title: string;
	updatedAt: Date;
	model?: string;
	avatarUrl?: string | Promise<string | undefined>;
	/** Started in ML Intern mode — the sidebar marks these and shows their turn status. */
	mlAssistant?: boolean;
	/**
	 * The project it belongs to, if any. The sidebar tree shows a project's
	 * chats under the project, so the flat Chats branch excludes these —
	 * without it every project conversation would appear in both places.
	 */
	projectId?: string;
}
