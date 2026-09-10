/**
 * The conversations in one project, newest activity first.
 *
 * Everyone who can see the project sees the whole list, including conversations
 * other people started. That is the point of sharing a project rather than
 * sharing chats one at a time — a shared project is a shared workspace — and
 * the project page says so plainly so nobody discovers it by finding their own
 * thread in a colleague's list.
 *
 * The message bodies are not sent, only the titles and timestamps. Reading a
 * conversation still goes through the conversation route, which enforces its
 * own rules.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { collections } from "$lib/server/database";
import { projectAccess, viewerPrincipals } from "$lib/server/projects";

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, "Login required");
	const principals = await viewerPrincipals(locals.user, locals.token);
	const access = await projectAccess(params.id as string, locals.user._id, principals);
	if (!access) error(404, "No such project.");

	const conversations = await collections.conversations
		.find({ projectId: access.project._id })
		.project<{ _id: object; title: string; model: string; updatedAt: Date; userId?: object }>({
			title: 1,
			model: 1,
			updatedAt: 1,
			userId: 1,
		})
		.sort({ updatedAt: -1 })
		.limit(200)
		.toArray();

	return json({
		data: conversations.map((conversation) => ({
			id: conversation._id.toString(),
			title: conversation.title,
			model: conversation.model,
			updatedAt: conversation.updatedAt.toISOString(),
			mine: conversation.userId?.toString() === locals.user?._id.toString(),
		})),
	});
};
