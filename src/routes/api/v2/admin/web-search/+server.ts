/**
 * Which search backend web search runs on. Site-wide, administrator only.
 *
 * Mirrors the document-reader choice on the Knowledge screen: the gateway
 * offers the backends (`/v1/models?include=search`, bounded by the admin's own
 * grants), the admin picks one, and the choice is stored in the chat's own
 * Mongo. It is deliberately a sibling of the knowledge routes rather than part
 * of them — those 404 when the knowledge pipeline is switched off, and web
 * search has nothing to do with that switch.
 *
 * `WEB_SEARCH_MODEL` in the environment overrides the stored choice and is
 * reported as such, read-only.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";

import { requireAdmin } from "$lib/server/admin";
import { logger } from "$lib/server/logger";
import {
	envWebSearchModel,
	resolveWebSearchFor,
	storedWebSearchModel,
	writeWebSearchModel,
} from "$lib/server/webSearch/config";

async function status(token: string | undefined) {
	const resolution = await resolveWebSearchFor(token);
	const stored = await storedWebSearchModel();
	return {
		available_backends: resolution.granted,
		// What a search would actually name to the gateway; null = group policy.
		backend: resolution.model,
		stored_backend: stored,
		source: resolution.source,
		// A choice exists but is not among the backends offered to this admin.
		stale: resolution.stale,
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json(await status(locals.token));
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	if (envWebSearchModel()) {
		error(409, "The search backend is set in the environment (WEB_SEARCH_MODEL).");
	}
	const body = (await request.json().catch(() => null)) as { backend?: string | null } | null;
	if (!body || (body.backend !== null && typeof body.backend !== "string")) {
		error(
			400,
			"backend must be a search backend name, or null to let the gateway's policy decide."
		);
	}
	const backend = body.backend?.trim() || null;
	if (backend) {
		const { granted } = await resolveWebSearchFor(locals.token);
		if (!granted.includes(backend)) {
			error(400, `“${backend}” is not a search backend this gateway offers you.`);
		}
	}
	await writeWebSearchModel(backend);
	logger.info({ backend, admin: admin.email }, "web_search_backend_changed");
	return json(await status(locals.token));
};
