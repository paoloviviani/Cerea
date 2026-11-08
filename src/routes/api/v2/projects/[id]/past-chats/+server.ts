/**
 * A project's past-chats index: its status (any member), and Reindex (owner).
 * Reindex is the knowledge base reindex, aimed at the project's memory base;
 * it can also move the index to another embedding model the owner may use.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { knowledgeEnabled } from "$lib/server/knowledgeEnabled";
import { requireProjectAccess } from "$lib/server/projects";
import { pastChatsIndex } from "$lib/server/knowledge/pastChats";
import { KnowledgeError } from "$lib/server/knowledge/service";

export const GET: RequestHandler = async ({ locals, params }) => {
	const { project, owned } = await requireProjectAccess(locals, params.id);
	return json({
		data: { ...(await pastChatsIndex(project.memoryBaseId, locals.token)), canManage: owned },
	});
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const { project, owned } = await requireProjectAccess(locals, params.id);
	if (!owned) error(403, "Only the project owner can reindex past chats.");
	if (!knowledgeEnabled()) error(404, "Knowledge bases are not enabled in this deployment.");
	if (!project.memoryBaseId) error(404, "This project has no past-chats index yet.");
	if (!locals.token) {
		error(401, "This needs a session from the identity provider. Log out and sign in through it.");
	}
	// Optionally `{ embedding_model }`: the owner's embedder for this index.
	const body = (await request.json().catch(() => null)) as { embedding_model?: unknown } | null;
	const { callerFrom, reindex } = await import("$lib/server/knowledge/service");
	try {
		await reindex(project.memoryBaseId, await callerFrom(locals), locals.token, {
			...(typeof body?.embedding_model === "string"
				? { embeddingModel: body.embedding_model }
				: {}),
		});
	} catch (err) {
		if (err instanceof KnowledgeError) error(err.status, err.message);
		throw err;
	}
	return json({
		data: { ...(await pastChatsIndex(project.memoryBaseId, locals.token)), canManage: true },
	});
};
