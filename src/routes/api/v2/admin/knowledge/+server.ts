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
 *
 * The GET and PUT bodies are the **whole** status the screen renders, not a
 * summary of the settings row: `adminStatus` in the service builds it, and the
 * page reads `bases`, `available_embedding_models`, `history` and the rest
 * unguarded. That contract was broken once — the GET answered with the seven
 * fields the old proxy used to forward, the page threw on the first missing
 * one, and the screen sat on "Loading…" for good — which is why the shape
 * lives in one place, built once, rather than being restated per handler.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";

import { requireAdmin } from "$lib/server/admin";
import { knowledgeEnabled } from "$lib/server/knowledgeEnabled";
import { logger } from "$lib/server/logger";
import type { KnowledgeConfig } from "$lib/types/VectorStore";

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	if (!knowledgeEnabled()) {
		error(404, "Knowledge bases are not enabled in this deployment.");
	}
	const { adminStatus } = await import("$lib/server/knowledge/service");
	return json(await adminStatus(locals.token));
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const identity = await requireAdmin(locals);
	if (!knowledgeEnabled()) {
		error(404, "Knowledge bases are not enabled in this deployment.");
	}
	const body = (await request.json()) as {
		enabled?: boolean;
		embedding_model?: string | null;
		extractor_model?: string | null;
		clear_extractor?: boolean;
		chunk_chars?: number;
		chunk_overlap?: number;
		reason?: string;
	};
	if (body.chunk_chars !== undefined) {
		const n = Number(body.chunk_chars);
		if (!Number.isFinite(n) || n < 80 || n > 20000) {
			error(400, "chunk_chars must be between 80 and 20000.");
		}
	}
	if (body.chunk_overlap !== undefined) {
		const n = Number(body.chunk_overlap);
		if (!Number.isFinite(n) || n < 0 || n > 5000) {
			error(400, "chunk_overlap must be between 0 and 5000.");
		}
	}
	// The bounds above are the form's own, so a value the screen offers can
	// never be refused here; the service caps the overlap at a third of the
	// passage size whatever arrives.

	// The one setting that alters where user documents are sent, and the one
	// this screen refuses to change without a stated reason. The form asks
	// client-side; this is the gate that cannot be bypassed.
	if (typeof body.extractor_model === "string" && body.extractor_model.trim()) {
		if (!body.reason?.trim()) {
			error(400, "Naming a model to read documents changes where they are sent. Say why.");
		}
	}

	// Only what changed. The store reads a missing column as "this row does
	// not decide", so sending a whole document would overwrite settings nobody
	// touched — and silently re-chunk every base created afterwards.
	const patch: Partial<KnowledgeConfig> = {};
	if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
	if (body.embedding_model !== undefined) patch.embeddingModel = body.embedding_model || null;
	if (body.clear_extractor) {
		patch.extractorModel = null;
	} else if (body.extractor_model !== undefined) {
		patch.extractorModel = body.extractor_model || null;
	}
	if (body.chunk_chars !== undefined) patch.chunkChars = Math.floor(Number(body.chunk_chars));
	if (body.chunk_overlap !== undefined) {
		patch.chunkOverlap = Math.floor(Number(body.chunk_overlap));
	}

	const { writeConfig, adminStatus } = await import("$lib/server/knowledge/service");
	const config = await writeConfig(patch, {
		changedBy: identity.email ?? locals.user?.email ?? null,
		reason: body.reason?.trim() || "",
	});
	logger.info(
		{ enabled: config.enabled, model: config.embeddingModel },
		"knowledge_config_updated"
	);
	// The saved status, not an acknowledgement: the screen's own notice reads
	// the stale-base count out of this answer, and "Saved" alone would leave
	// somebody unaware they had just stranded bases on an older model.
	return json(await adminStatus(locals.token));
};
