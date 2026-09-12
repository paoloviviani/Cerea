/**
 * The knowledge pipeline's configuration — the chat's own, since ADR 0070.
 *
 * The store and its pipeline live here now; this config is what the pipeline
 * reads. The gate stays the same in kind as the admin area's: the gateway's
 * answer to "is this person an administrator" (via `callerIdentity`), not the
 * chat's own `user.isAdmin`, which comes from a HuggingFace organisation claim
 * and has nothing to do with who administers this deployment. A pipeline that
 * decides where documents are embedded and spent on deserves the same gate as
 * the rest of the administration surface.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";

import { callerIdentity } from "$lib/server/admin";
import { logger } from "$lib/server/logger";

async function requireAdmin(locals: App.Locals): Promise<void> {
	if (!locals.user) error(401, "Login required");
	const identity = await callerIdentity(locals);
	if (!identity) {
		error(401, "This needs a session from the identity provider. Log out and sign in through it.");
	}
	if (!identity.isAdmin) {
		error(403, "This deployment's gateway does not list you as an administrator.");
	}
}

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	const { readConfig, statusObject } = await import("$lib/server/knowledge/service");
	const user = locals.user;
	if (!user) error(401, "Login required");
	const config = await readConfig();
	const status = await statusObject(
		{
			userId: user._id,
			email: user.email ?? null,
			groups: [],
			isAdmin: true,
		},
		locals.token
	);
	return json({
		enabled: config.enabled,
		embedding_model: config.embeddingModel,
		chunk_chars: config.chunkChars,
		chunk_overlap: config.chunkOverlap,
		ready: status.ready,
		detail: status.detail,
		max_upload_bytes: status.max_upload_bytes,
	});
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	await requireAdmin(locals);
	const body = (await request.json()) as {
		enabled?: boolean;
		embedding_model?: string | null;
		chunk_chars?: number;
		chunk_overlap?: number;
	};
	if (body.chunk_chars !== undefined) {
		const n = Number(body.chunk_chars);
		if (!Number.isFinite(n) || n < 80 || n > 8000) {
			error(400, "chunk_chars must be between 80 and 8000.");
		}
	}
	if (body.chunk_overlap !== undefined) {
		const n = Number(body.chunk_overlap);
		if (!Number.isFinite(n) || n < 0 || n > 2000) {
			error(400, "chunk_overlap must be between 0 and 2000.");
		}
	}
	const { writeConfig } = await import("$lib/server/knowledge/service");
	const config = await writeConfig({
		...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
		...(body.embedding_model !== undefined ? { embeddingModel: body.embedding_model } : {}),
		...(body.chunk_chars !== undefined ? { chunkChars: Math.floor(body.chunk_chars) } : {}),
		...(body.chunk_overlap !== undefined ? { chunkOverlap: Math.floor(body.chunk_overlap) } : {}),
	});
	logger.info(
		{ enabled: config.enabled, model: config.embeddingModel },
		"knowledge_config_updated"
	);
	return json({ saved: true });
};
