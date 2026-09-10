/**
 * One forwarder to the gateway, for the surfaces the browser is allowed to use.
 *
 * Knowledge bases and agents are user-facing resources with a dozen operations
 * between them — list, create, update, delete, upload, attach, search, share,
 * unshare, on two resource types. Written as one route file per operation that
 * is a dozen files of the same eight lines, and the eight lines are the part
 * that must not vary: attach the session's token, relay the gateway's own
 * status, never let the token reach the page.
 *
 * **The allowlist is the security property, not tidiness.** A path parameter
 * forwarded blindly would hand the browser the user's entire `/v1` authority —
 * their token, applied to any endpoint they can name — which is precisely what
 * keeping the token on the server prevents. So the prefixes are enumerated,
 * and anything else is a 404 rather than a proxied request.
 *
 * Note what is deliberately *not* allowed through: `chat/completions` and the
 * other generation surfaces. They already have their own paths in this app,
 * with the tool loop, the abort handling and the accounting the chat needs;
 * a second way in that skipped all of it would be a way to spend money this
 * app cannot see.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";

/**
 * Gateway paths the browser may reach, as anchored patterns.
 *
 * Anchored on purpose: an unanchored `vector_stores` would also match
 * `chat/completions?x=vector_stores`, which is the shape of mistake an
 * allowlist exists to prevent.
 */
const ALLOWED: RegExp[] = [
	// Knowledge bases: the collection, one base, its documents, its shares, and
	// searching it.
	/^vector_stores$/,
	/^vector_stores\/status$/,
	/^vector_stores\/[0-9a-f-]{36}$/,
	/^vector_stores\/[0-9a-f-]{36}\/(files|text|search|reindex)$/,
	/^vector_stores\/[0-9a-f-]{36}\/files\/[0-9a-f-]{36}$/,
	/^vector_stores\/[0-9a-f-]{36}\/shares$/,
	/^vector_stores\/[0-9a-f-]{36}\/shares\/(user|group)\/[0-9a-f-]{36}$/,
	// Files: upload and delete. Reading one back is *not* here — a knowledge
	// base's own passages are what the chat shows, and serving arbitrary
	// uploaded bytes back through this origin is a decision with its own
	// reasons (see `files.py`, which sets an attachment disposition for them).
	/^files$/,
	/^files\/[0-9a-f-]{36}$/,
	// Agents, and their shares.
	/^agents$/,
	/^agents\/[0-9a-f-]{36}$/,
	/^agents\/[0-9a-f-]{36}\/shares$/,
	/^agents\/[0-9a-f-]{36}\/shares\/(user|group)\/[0-9a-f-]{36}$/,
	// The caller's billable groups, so a share dialog can offer them by name.
	/^billing\/groups$/,
	// The model list, so an agent form can offer the models this person may
	// actually use rather than every model the deployment has.
	/^models$/,
];

function target(path: string, search: string): string {
	if (!config.OPENAI_BASE_URL) {
		error(404, "This deployment has no gateway configured.");
	}
	if (!ALLOWED.some((pattern) => pattern.test(path))) {
		// 404 rather than 403: this forwarder does not offer that path at all,
		// and saying "forbidden" would imply it might with different
		// credentials.
		error(404, "Not available through this endpoint.");
	}
	return `${config.OPENAI_BASE_URL.replace(/\/$/, "")}/${path}${search}`;
}

function token(locals: App.Locals): string {
	if (!locals.user) {
		error(401, "Login required");
	}
	if (!locals.token) {
		// Signed in without an OIDC session — a development login, or a session
		// older than the token. Named, because a bare 401 on a page that just
		// rendered sends people to the wrong place.
		error(401, "This needs an OIDC session. Sign out and back in through the provider.");
	}
	return locals.token;
}

/** The gateway's status and body, verbatim, including its refusals. */
async function relay(response: Response): Promise<Response> {
	const body = await response.text();
	// Passed through rather than re-wrapped: the gateway's messages are written
	// to be read by whoever caused them ("you have read-only access to this
	// vector store"), and a generic "request failed" would throw that away.
	return new Response(body, {
		status: response.status,
		headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
	});
}

async function forward(
	event: Parameters<RequestHandler>[0],
	method: "GET" | "POST" | "DELETE"
): Promise<Response> {
	const path = event.params.path ?? "";
	const bearer = token(event.locals);
	const url = target(path, event.url.search);

	const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
	let body: BodyInit | undefined;
	if (method !== "GET" && method !== "DELETE") {
		const contentType = event.request.headers.get("content-type") ?? "";
		if (contentType.includes("multipart/form-data")) {
			// Passed as a stream with its own boundary intact. Re-encoding it
			// here would mean buffering an upload in this process for no
			// reason — the gateway is the one enforcing the size limit, and it
			// does so while reading.
			headers["content-type"] = contentType;
			body = await event.request.arrayBuffer();
		} else {
			headers["content-type"] = "application/json";
			body = await event.request.text();
		}
	}

	try {
		return await relay(await event.fetch(url, { method, headers, body }));
	} catch (err) {
		if (err && typeof err === "object" && "status" in err) throw err;
		logger.error({ err, path }, "gateway forward failed");
		error(502, "The gateway could not be reached.");
	}
}

export const GET: RequestHandler = (event) => forward(event, "GET");
export const POST: RequestHandler = (event) => forward(event, "POST");
export const DELETE: RequestHandler = (event) => forward(event, "DELETE");
