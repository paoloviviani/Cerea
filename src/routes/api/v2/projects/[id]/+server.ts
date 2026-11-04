/**
 * One project: read it, change it, delete it.
 *
 * Only the owner may change or delete. Somebody a project was shared with can
 * read it and start conversations in it — that is what the share is for — but
 * its instructions and its knowledge bases are the owner's, and a shared
 * editor would be able to redirect every future conversation in it.
 *
 * Deleting a project deletes the owner's chats in it (everything a deleted
 * conversation leaves behind goes too), its past-chats knowledge base, notes and
 * context documents. `?keepChats=1` detaches the chats instead: they keep
 * existing and appear in the ordinary chat list. Other members' chats in a
 * shared project are always detached, never deleted. Attached knowledge bases
 * are gateway resources with their own owner and are never touched.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import { logger } from "$lib/server/logger";
import { rejectMemoryBases } from "$lib/server/knowledge/memoryBases";
import { deleteConversationStorage } from "$lib/server/conversationStorage";
import { deleteDerived } from "$lib/server/knowledge/deleteDerived";
import { deleteProjectDocuments } from "$lib/server/projectDocuments";
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
	if (parsed.data.knowledgeBaseIds) await rejectMemoryBases(parsed.data.knowledgeBaseIds);
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
	const keepChats = ["1", "true"].includes(url.searchParams.get("keepChats") ?? "");
	// `?memory=delete` is accepted and ignored: the past-chats base is always
	// deleted now, and an older client may still send it.
	const project = access.project;

	// Chats first, then the memory, then notes and documents, and the project
	// row last: a failure midway leaves a project that still exists, never one
	// pointing at deleted things.
	const rows = await collections.conversations
		.find({ projectId: project._id })
		.project<{ _id: Conversation["_id"]; userId?: Conversation["userId"] }>({ _id: 1, userId: 1 })
		.toArray();
	// Only the owner's own chats are the owner's to delete. A member's chat in a
	// shared project is theirs: it is detached and goes back to their list.
	const ownedIds = keepChats
		? []
		: rows.filter((row) => row.userId?.equals(project.userId)).map((row) => row._id);
	const owned = new Set(ownedIds.map(String));
	const detachIds = rows.map((row) => row._id).filter((id) => !owned.has(String(id)));

	if (ownedIds.length > 0) {
		await collections.conversations.deleteMany({ _id: { $in: ownedIds } });
		await deleteConversationStorage(ownedIds);
	}
	if (detachIds.length > 0) {
		await collections.conversations.updateMany(
			{ _id: { $in: detachIds } },
			{ $unset: { projectId: "" } }
		);
		// A chat no longer in the project must stop surfacing in its retrieval
		// (`conversationStorage.ts`'s note on moving a conversation out).
		for (const conversationId of detachIds) {
			await deleteDerived({ conversationId }).catch((err) =>
				logger.warn({ err, conversationId }, "project_delete_transcript_cleanup_failed")
			);
		}
	}

	// The past-chats base is always deleted, but only when the project's owner
	// owns it: one made by a member before the base belonged to the project is
	// theirs, and is left alone. Attached knowledge bases are never touched.
	const memoryId = project.memoryBaseId;
	if (memoryId && ObjectId.isValid(memoryId)) {
		const base = await collections.vectorStores.findOne({ _id: new ObjectId(memoryId) });
		if (base?.ownerId.equals(project.userId)) {
			await deleteDerived({ storeIds: base._id, dropStores: true });
		}
	}
	// Its notes and context documents (rows and stored files) are the
	// project's and go with it: no screen would list them otherwise.
	await collections.projectMemories.deleteMany({ projectId: project._id });
	// Every member's own agent profile for it (ADR 0106): each names a machine, not the project's.
	await collections.projectAgentProfiles.deleteMany({ projectId: project._id });
	await deleteProjectDocuments(project._id);
	await collections.projects.deleteOne({ _id: project._id });
	return new Response(null, { status: 204 });
};
