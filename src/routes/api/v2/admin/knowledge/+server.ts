/**
 * The knowledge pipeline's configuration, proxied to the gateway.
 *
 * A proxy rather than a direct call from the browser, for the reason every
 * gateway call in this app goes through the server: the user's OIDC access
 * token lives in the session and is never handed to client code. Putting it in
 * a browser would make every extension on the page a gateway client.
 *
 * **Who may do this is the gateway's decision, not ours.** This route checks
 * only that somebody is signed in and forwards their token; the gateway's
 * `/v1/knowledge/config` refuses anyone who is not an administrator, and its
 * 403 is passed straight through. That is deliberate: `user.isAdmin` here is
 * derived from a HuggingFace organisation claim (`updateUser.ts`), which has
 * nothing to do with who administers *this* deployment. Two answers to "is
 * this person an administrator" is one answer too many, and the gateway's is
 * the one that governs the data.
 *
 * It also refuses to work with an API key, by construction — there is no key
 * here to send. The gateway requires a bearer token for this surface precisely
 * so that changing where documents are sent needs a person who signed in
 * (ADR 0062).
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";

function gatewayBase(): string {
	if (!config.OPENAI_BASE_URL) {
		error(404, "This deployment has no gateway configured.");
	}
	return config.OPENAI_BASE_URL.replace(/\/$/, "");
}

function requireToken(locals: App.Locals): string {
	if (!locals.user) {
		error(401, "Login required");
	}
	if (!locals.token) {
		// Signed in with something that is not an OIDC session — a local
		// development login, or a session predating the token. Says which,
		// because "403" on an admin screen sends people to the wrong place.
		error(401, "This needs an OIDC session. Log out and sign in through the identity provider.");
	}
	return locals.token;
}

/** Pass the gateway's own status and body through, including its refusals. */
async function relay(response: Response): Promise<Response> {
	const text = await response.text();
	if (!response.ok) {
		let message = text;
		try {
			const parsed = JSON.parse(text) as { error?: { message?: string }; detail?: string };
			message = parsed.error?.message ?? parsed.detail ?? text;
		} catch {
			/* not JSON; the raw text is the best available */
		}
		// The gateway's status, not a blanket 502: a 403 means "you are not an
		// administrator" and a 404 means "the feature is off", and collapsing
		// them would make the screen unable to say which.
		error(response.status, message || "The gateway refused the request.");
	}
	return json(JSON.parse(text));
}

export const GET: RequestHandler = async ({ locals, fetch }) => {
	const token = requireToken(locals);
	try {
		return await relay(
			await fetch(`${gatewayBase()}/knowledge/config`, {
				headers: { Authorization: `Bearer ${token}` },
			})
		);
	} catch (err) {
		if (err && typeof err === "object" && "status" in err) throw err;
		logger.error(err, "reading the knowledge configuration");
		error(502, "The gateway could not be reached.");
	}
};

export const PUT: RequestHandler = async ({ locals, request, fetch }) => {
	const token = requireToken(locals);
	// Forwarded as received. Validating the shape here as well as in the
	// gateway would mean two schemas for one form, and the gateway's is the one
	// that decides — including the rule that a third-party extractor needs a
	// stated reason.
	const body = await request.text();
	try {
		return await relay(
			await fetch(`${gatewayBase()}/knowledge/config`, {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body,
			})
		);
	} catch (err) {
		if (err && typeof err === "object" && "status" in err) throw err;
		logger.error(err, "writing the knowledge configuration");
		error(502, "The gateway could not be reached.");
	}
};
