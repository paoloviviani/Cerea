/**
 * Re-embed one knowledge base, proxied to the gateway.
 *
 * Separate from the configuration route because it is a different verb on a
 * different resource, and because it is the one action on this screen that
 * spends money: a reindex embeds every passage in the base again. Whose money
 * is not this route's decision — the gateway bills the **base's** group rather
 * than the caller's, so an administrator pressing the button does not move
 * somebody else's cost onto their own budget.
 *
 * The base id comes in the body rather than the path so that this stays one
 * route. A path parameter would have meant a directory per id shape and
 * nothing gained: the gateway validates the uuid and answers 404 for one it
 * does not have.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";

export const POST: RequestHandler = async ({ locals, request, fetch }) => {
	if (!locals.user) {
		error(401, "Login required");
	}
	if (!locals.token) {
		error(401, "This needs an OIDC session. Log out and sign in through the provider.");
	}
	if (!config.OPENAI_BASE_URL) {
		error(404, "This deployment has no gateway configured.");
	}

	const body = (await request.json()) as { base_id?: string };
	if (!body.base_id) {
		error(400, "base_id is required.");
	}

	const base = config.OPENAI_BASE_URL.replace(/\/$/, "");
	try {
		const response = await fetch(`${base}/knowledge/bases/${body.base_id}/reindex`, {
			method: "POST",
			headers: { Authorization: `Bearer ${locals.token}` },
		});
		const text = await response.text();
		if (!response.ok) {
			let message = text;
			try {
				const parsed = JSON.parse(text) as { error?: { message?: string } };
				message = parsed.error?.message ?? text;
			} catch {
				/* not JSON */
			}
			error(response.status, message || "The reindex was refused.");
		}
		return json(JSON.parse(text));
	} catch (err) {
		if (err && typeof err === "object" && "status" in err) throw err;
		logger.error(err, "reindexing a knowledge base");
		error(502, "The gateway could not be reached.");
	}
};
