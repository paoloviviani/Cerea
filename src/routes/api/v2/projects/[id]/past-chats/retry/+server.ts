/** Retry the failed documents of a project's past-chats index (owner only). */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { knowledgeEnabled } from "$lib/server/knowledgeEnabled";
import { requireProjectAccess } from "$lib/server/projects";
import { failedDocumentIds, pastChatsIndex } from "$lib/server/knowledge/pastChats";
import { KnowledgeError } from "$lib/server/knowledge/service";

export const POST: RequestHandler = async ({ locals, params }) => {
	const { project, owned } = await requireProjectAccess(locals, params.id);
	if (!owned) error(403, "Only the project owner can retry past chats.");
	if (!knowledgeEnabled()) error(404, "Knowledge bases are not enabled in this deployment.");
	if (!project.memoryBaseId) error(404, "This project has no past-chats index yet.");
	if (!locals.token) {
		error(401, "This needs a session from the identity provider. Log out and sign in through it.");
	}
	const { callerFrom, retryDocument, reindexTarget } =
		await import("$lib/server/knowledge/service");
	try {
		const caller = await callerFrom(locals);
		// The same owner rule as Reindex.
		await reindexTarget(project.memoryBaseId, caller);
		for (const id of await failedDocumentIds(project.memoryBaseId)) {
			await retryDocument(project.memoryBaseId, id, caller, locals.token);
		}
	} catch (err) {
		if (err instanceof KnowledgeError) error(err.status, err.message);
		throw err;
	}
	return json({
		data: { ...(await pastChatsIndex(project.memoryBaseId, locals.token)), canManage: true },
	});
};
