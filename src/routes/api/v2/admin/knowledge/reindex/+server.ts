/**
 * Re-embed one knowledge base — the chat's own store, since ADR 0070.
 *
 * Separate from the configuration route because it is a different verb on a
 * different resource, and because it is the one action on this screen that
 * spends money: a reindex embeds every passage in the base again. Whose money
 * is not this route's decision — the embeddings carry the acting
 * administrator's token, and the ledger shows it.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";

import { callerIdentity } from "$lib/server/admin";
import { KnowledgeError } from "$lib/server/knowledge/service";

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) {
		error(401, "Login required");
	}
	if (!locals.token) {
		error(401, "This needs an OIDC session. Log out and sign in through the provider.");
	}
	const identity = await callerIdentity(locals);
	if (!identity?.isAdmin) {
		error(403, "This deployment's gateway does not list you as an administrator.");
	}

	const body = (await request.json()) as { base_id?: string };
	if (!body.base_id) {
		error(400, "base_id is required.");
	}

	const { callerFrom, reindex } = await import("$lib/server/knowledge/service");
	const caller = await callerFrom(locals);
	try {
		return json(await reindex(body.base_id, caller, locals.token));
	} catch (err) {
		if (err instanceof KnowledgeError) {
			error(err.status, err.message);
		}
		throw err;
	}
};
