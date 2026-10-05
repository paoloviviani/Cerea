/**
 * One project: read it, change it, delete it.
 *
 * Only the owner may change or delete. Somebody a project was shared with can
 * read it and start conversations in it — that is what the share is for — but
 * its instructions and its knowledge bases are the owner's, and a shared
 * editor would be able to redirect every future conversation in it.
 *
 * Deleting a project does **not** delete its conversations, and does not delete
 * its knowledge bases. The conversations keep their `projectId`, pointing at
 * nothing, and appear in the ordinary chat list again; the bases are gateway
 * resources with their own owner and their own lifecycle. Cascading either
 * would make "delete this project" a destructive act somebody performs to tidy
 * a sidebar.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import { logger } from "$lib/server/logger";
import { deleteDerived } from "$lib/server/knowledge/deleteDerived";
import {
	knowledgeBaseId,
	projectAccess,
	projectView,
	viewerPrincipals,
} from "$lib/server/projects";

const patch = z.object({
	name: z.string().trim().min(1).max(128).optional(),
	description: z.string().trim().max(500).optional(),
	instructions: z.string().max(20_000).optional(),
	knowledgeBaseIds: z.array(knowledgeBaseId).max(20).optional(),
	indexPastChats: z.boolean().optional(),
	retrievalLimit: z.number().int().min(1).max(20).optional(),
	defaultWebSearch: z.boolean().optional(),
	defaultMcpConnectorIds: z.array(z.string().min(1).max(64)).max(50).optional(),
});

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const principals = await viewerPrincipals(user, locals.token);
	const access = await projectAccess(params.id as string, user._id, principals);
	if (!access) error(404, "No such project.");
	return json(await projectView(access));
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const principals = await viewerPrincipals(user, locals.token);
	const access = await projectAccess(params.id as string, user._id, principals);
	if (!access) error(404, "No such project.");
	if (!access.owned) error(403, "Only the person who created a project can change it.");

	const parsed = patch.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That change is not valid.");
	}
	const changes = { ...parsed.data, updatedAt: new Date() };
	await collections.projects.updateOne({ _id: access.project._id }, { $set: changes });
	const updated = await collections.projects.findOne({ _id: access.project._id });
	if (!updated) error(404, "No such project.");
	return json(await projectView({ project: updated, owned: true }));
};

export const DELETE: RequestHandler = async ({ locals, params, url }) => {
	const user = requireUser(locals);
	const principals = await viewerPrincipals(user, locals.token);
	const access = await projectAccess(params.id as string, user._id, principals);
	if (!access) error(404, "No such project.");
	if (!access.owned) error(403, "Only the person who created a project can delete it.");
	// Off by default: the past-chats memory is an ordinary knowledge base that
	// outlives its project unless the person says otherwise (`?memory=delete`).
	// Only a base the project's owner owns is theirs to drop; one made by a
	// member before the base belonged to the project is left alone.
	const memoryId = access.project.memoryBaseId;
	if (url.searchParams.get("memory") === "delete" && memoryId && ObjectId.isValid(memoryId)) {
		const base = await collections.vectorStores.findOne({ _id: new ObjectId(memoryId) });
		if (base?.ownerId.equals(access.project.userId)) {
			await deleteDerived({ storeIds: base._id, dropStores: true });
		}
	}
	// Its chats are kept, and go back to the ordinary list, as the dialog says:
	// without this they kept a `projectId` naming nothing, which no list shows.
	// Their transcripts leave the project's memory, though — a chat that is no
	// longer in the project must stop surfacing in its retrieval
	// (`conversationStorage.ts`'s note on moving a conversation out).
	const conversationIds = await collections.conversations
		.find({ projectId: access.project._id })
		.project<{ _id: Conversation["_id"] }>({ _id: 1 })
		.toArray()
		.then((rows) => rows.map((row) => row._id));
	if (conversationIds.length > 0) {
		await collections.conversations.updateMany(
			{ _id: { $in: conversationIds } },
			{ $unset: { projectId: "" } }
		);
		for (const conversationId of conversationIds) {
			await deleteDerived({ conversationId }).catch((err) =>
				logger.warn({ err, conversationId }, "project_delete_transcript_cleanup_failed")
			);
		}
	}
	// Its notes are the project's and go with it (they would otherwise be
	// unreachable rows no screen lists), unlike its chats, which are kept.
	await collections.projectMemories.deleteMany({ projectId: access.project._id });
	await collections.projects.deleteOne({ _id: access.project._id });
	return new Response(null, { status: 204 });
};
