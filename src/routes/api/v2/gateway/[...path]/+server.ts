/**
 * One forwarder to the gateway, for the surfaces the browser is allowed to use.
 *
 * Knowledge bases are user-facing resources with a dozen operations
 * between them — list, create, update, delete, upload, attach, search, share,
 * unshare, on two resource types. Written as one route file per operation that
 * is a dozen files of the same eight lines, and the eight lines are the part
 * that must not vary: attach the session's token, relay the caller's own
 * status, never let the token reach the page.
 *
 * **The allowlist is the security property, not tidiness.** A path parameter
 * forwarded blindly would hand the browser the user's entire `/v1` authority —
 * their token, applied to any endpoint they can name — which is precisely what
 * keeping the token on the server prevents. So the prefixes are enumerated,
 * and anything else is a 404 rather than a proxied request.
 *
 * Since ADR 0070 the `vector_stores` and `files` paths no longer forward:
 * the vector store belongs to the chat, and these are served by the chat's
 * own knowledge module in-process. The paths keep their place on the
 * allowlist — they authorise *handling* now, not a second hop — and the
 * browser's URLs do not move. Everything else still forwards to the gateway.
 *
 * Note what is deliberately *not* allowed through: `chat/completions` and the
 * other generation surfaces. They already have their own paths in this app,
 * with the tool loop, the abort handling and the accounting the chat needs;
 * a second way in that skipped all of it would be a way to spend money this
 * app cannot see.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";

/**
 * Gateway paths the browser may reach, as anchored patterns.
 *
 * Knowledge bases: the collection, one base, its documents, its shares, and
 * searching it — handled in-process since ADR 0070. Files: upload and delete;
 * reading one back is *not* here — a knowledge base's own passages are what
 * the chat shows, and serving arbitrary uploaded bytes back through this
 * origin is a decision with its own reasons. The one carve-out is a
 * document's *indexed text* (`.../content`), which the code-execution
 * runtime mounts for analysis: it is the retrieval payload, behind the same
 * viewer check, and still never the raw upload.
 */
const INTERNAL = [
	/^vector_stores$/,
	/^vector_stores\/status$/,
	/^vector_stores\/[0-9a-f-]{24}$/,
	/^vector_stores\/[0-9a-f-]{24}\/(files|text|search|reindex|shares)$/,
	/^vector_stores\/[0-9a-f-]{24}\/files\/[0-9a-f-]{24}$/,
	// A document's *indexed text* for the code-execution runtime — the
	// retrieval payload behind the same viewer check, never the raw upload.
	/^vector_stores\/[0-9a-f-]{24}\/files\/[0-9a-f-]{24}\/content$/,
	/^files$/,
	/^files\/[0-9a-f-]{24}$/,
];

/** Paths that still belong to the gateway, forwarded with the caller's token. */
const FORWARDED = [
	/^vector_stores\/[0-9a-f-]{36}.*$/,
	// The caller's billable groups, so a share dialog can offer them by name.
	/^billing\/groups$/,
	// The model list, so a share dialog can offer the models this person may
	// actually use rather than every model the deployment has.
	/^models$/,
];

function target(path: string, search: string): string {
	if (!config.OPENAI_BASE_URL) {
		error(404, "This deployment has no gateway configured.");
	}
	if (!INTERNAL.some((pattern) => pattern.test(path)) && !FORWARDED.some((p) => p.test(path))) {
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

/** Knowledge errors speak HTTP already; pass the status and message through. */
async function handled(fn: () => Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (err) {
		const { KnowledgeError } = await import("$lib/server/knowledge/service");
		if (err instanceof KnowledgeError) {
			return json({ error: { message: err.message } }, { status: err.status });
		}
		throw err;
	}
}

/** The chat's own store, behind the same URLs the browser already calls. */
async function handleInternal(
	path: string,
	method: "GET" | "POST" | "DELETE",
	event: Parameters<RequestHandler>[0]
): Promise<Response> {
	const bearer = token(event.locals);
	const { callerFrom } = await import("$lib/server/knowledge/service");
	const caller = await callerFrom(event.locals);
	// A small router over the same paths the gateway answered, so the screens
	// needed no edits when the store moved. `fetch` errors become 502s, like
	// a refused forward would be.
	try {
		const service = await import("$lib/server/knowledge/service");

		if (path === "files" && method === "POST") {
			const form = await event.request.formData();
			const file = form.get("file");
			if (!(file instanceof File)) error(400, "A file is required.");
			const bytes = Buffer.from(await file.arrayBuffer());
			const stored = await service.storeUpload(
				{ name: file.name, bytes, mime: file.type || "application/octet-stream" },
				caller.userId
			);
			return json({ id: stored.id, filename: stored.filename, bytes: stored.bytes });
		}

		const fileMatch = /^files\/([0-9a-f-]{24})$/.exec(path);
		if (fileMatch && method === "DELETE") {
			await service.deleteUpload(fileMatch[1], caller);
			return json({ id: fileMatch[1], object: "file", deleted: true });
		}

		if (path === "vector_stores/status" && method === "GET") {
			return json(await service.statusObject(caller, bearer));
		}

		if (path === "vector_stores") {
			if (method === "GET") return json(await service.listStores(caller));
			if (method === "POST") {
				return json(await service.createStore(caller, await event.request.json()));
			}
		}

		const storeMatch = /^vector_stores\/([0-9a-f-]{24})$/.exec(path);
		if (storeMatch) {
			if (method === "GET") {
				const base = await service.reachableStore(storeMatch[1], caller);
				return json(await service.storeObject(base, caller));
			}
			if (method === "DELETE") {
				await service.deleteStore(storeMatch[1], caller);
				return json({ id: storeMatch[1], object: "vector_store.deleted", deleted: true });
			}
		}

		const sub = /^vector_stores\/([0-9a-f-]{24})\/(\w+)$/.exec(path);
		if (sub) {
			const [, id, action] = sub;
			if (action === "files" && method === "GET")
				return json(await service.listDocuments(id, caller));
			if (action === "files" && method === "POST") {
				return json(await service.attachFile(id, caller, bearer, await event.request.json()));
			}
			if (action === "text" && method === "POST") {
				return json(await service.addText(id, caller, bearer, await event.request.json()));
			}
			if (action === "search" && method === "POST") {
				return json(await service.search(id, caller, bearer, await event.request.json()));
			}
			if (action === "reindex" && method === "POST") {
				return json(await service.reindex(id, caller, bearer));
			}
			if (action === "shares" && method === "GET")
				return json(await service.listShares(id, caller));
			if (action === "shares" && method === "POST") {
				await service.addShare(id, caller, await event.request.json());
				return json({ shared: true });
			}
		}

		const docMatch = /^vector_stores\/([0-9a-f-]{24})\/files\/([0-9a-f-]{24})$/.exec(path);
		if (docMatch && method === "DELETE") {
			await service.deleteDocument(docMatch[1], docMatch[2], caller);
			return json({ id: docMatch[2], object: "vector_store.file.deleted", deleted: true });
		}

		const contentMatch = /^vector_stores\/([0-9a-f-]{24})\/files\/([0-9a-f-]{24})\/content$/.exec(
			path
		);
		if (contentMatch && method === "GET") {
			return json(await service.readDocumentText(contentMatch[1], contentMatch[2], caller));
		}

		error(404, "Not available through this endpoint.");
	} catch (err) {
		if (err && typeof err === "object" && "status" in err && "body" in err) throw err;
		logger.error({ err, path }, "knowledge handling failed");
		error(502, "The knowledge store could not be reached.");
	}
}

/** The gateway's status and body, verbatim. */
async function forward(
	event: Parameters<RequestHandler>[0],
	method: "GET" | "POST" | "DELETE"
): Promise<Response> {
	const path = event.params.path ?? "";
	const isInternal = INTERNAL.some((pattern) => pattern.test(path));
	if (isInternal) {
		return handleInternal(path, method, event);
	}

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

export const GET: RequestHandler = (event) => handled(() => forward(event, "GET"));
export const POST: RequestHandler = (event) => handled(() => forward(event, "POST"));
export const DELETE: RequestHandler = (event) => handled(() => forward(event, "DELETE"));
