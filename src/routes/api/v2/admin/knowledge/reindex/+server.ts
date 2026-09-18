/**
 * Re-embed one knowledge base — the chat's own store, since ADR 0070.
 *
 * Separate from the configuration route because it is a different verb on a
 * different resource, and because it is the one action on this screen that
 * spends money: a reindex embeds every passage in the base again. Whose money
 * is not this route's decision — the embeddings carry the acting
 * administrator's token, and the ledger shows it.
 *
 * The answer is the whole admin status, same as the GET: the page re-seeds its
 * render from it, and a document list here would land in a shape the page
 * never reads.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";

import { requireAdmin } from "$lib/server/admin";
import { knowledgeEnabled } from "$lib/server/knowledgeEnabled";
import { KnowledgeError } from "$lib/server/knowledge/service";

export const POST: RequestHandler = async ({ locals, request }) => {
	await requireAdmin(locals);
	if (!knowledgeEnabled()) {
		error(404, "Knowledge bases are not enabled in this deployment.");
	}
	// The embeddings carry the acting administrator's own token; without one
	// there is nobody to bill the re-embedding to.
	if (!locals.token) {
		error(401, "This needs a session from the identity provider. Log out and sign in through it.");
	}

	const body = (await request.json()) as { base_id?: string };
	if (!body.base_id) {
		error(400, "base_id is required.");
	}

	const { callerFrom, reindex, adminStatus } = await import("$lib/server/knowledge/service");
	const caller = await callerFrom(locals);
	try {
		await reindex(body.base_id, caller, locals.token);
	} catch (err) {
		if (err instanceof KnowledgeError) {
			error(err.status, err.message);
		}
		throw err;
	}
	return json(await adminStatus(locals.token));
};
