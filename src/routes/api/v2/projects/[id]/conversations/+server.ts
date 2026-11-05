/**
 * The caller's own conversations in one project, newest activity first.
 *
 * A project is shared (instructions, knowledge, memory), its chats are not:
 * conversations open for their author only, so listing a colleague's chat
 * would be a dead end that also leaks its title. Other members' chats are
 * reduced to `othersCount`; their ids and titles never leave the server.
 *
 * The message bodies are not sent, only titles and timestamps.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { collections } from "$lib/server/database";
import { projectAccess, viewerPrincipals } from "$lib/server/projects";

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, "Login required");
	const principals = await viewerPrincipals(locals.user, locals.token);
	const access = await projectAccess(params.id as string, locals.user._id, principals);
	if (!access) error(404, "No such project.");

	const own = { projectId: access.project._id, userId: locals.user._id };
	const [conversations, totalCount] = await Promise.all([
		collections.conversations
			.find(own)
			.project<{ _id: object; title: string; model: string; updatedAt: Date }>({
				title: 1,
				model: 1,
				updatedAt: 1,
			})
			.sort({ updatedAt: -1 })
			.limit(200)
			.toArray(),
		collections.conversations.countDocuments({ projectId: access.project._id }),
	]);

	return json({
		data: conversations.map((conversation) => ({
			id: conversation._id.toString(),
			title: conversation.title,
			model: conversation.model,
			updatedAt: conversation.updatedAt.toISOString(),
		})),
		othersCount: Math.max(0, totalCount - conversations.length),
	});
};
