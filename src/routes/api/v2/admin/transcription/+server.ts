/**
 * The transcription model, chosen under Administration -> Assistant -> Voice &
 * audio: it governs dictation by a model and audio attachments alike. Its own
 * route, behind the same administrator gate as the rest of the admin area, and
 * independent of whether knowledge bases are enabled.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";

import { requireAdmin } from "$lib/server/admin";
import { logger } from "$lib/server/logger";
import {
	envTranscriptionModel,
	listTranscriptionModels,
	resolveTranscription,
	storedTranscriptionModel,
	writeTranscriptionModel,
} from "$lib/server/transcription";

async function status(token: string | undefined) {
	const available = token ? await listTranscriptionModels(token) : [];
	const stored = await storedTranscriptionModel().catch(() => null);
	const resolved = resolveTranscription({
		storedModel: stored,
		envModel: envTranscriptionModel(),
		candidates: available,
	});
	return {
		/** What would transcribe now, and why. */
		model: resolved.model,
		source: resolved.source,
		/** The administrator's own choice, or null for the deployment default. */
		stored_model: stored,
		env_model: envTranscriptionModel(),
		available_models: available,
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json(await status(locals.token));
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	const body = (await request.json().catch(() => null)) as { model?: unknown } | null;
	if (!body || typeof body !== "object" || !("model" in body)) {
		error(400, "Send {model: <name>} or {model: null} for the deployment default.");
	}
	const raw = body.model;
	if (raw !== null && typeof raw !== "string") {
		error(400, "model must be a model name or null.");
	}
	const model = typeof raw === "string" ? raw.trim() || null : null;
	if (model) {
		const available = locals.token ? await listTranscriptionModels(locals.token) : [];
		if (!available.includes(model)) {
			error(400, `${model} is not a transcription model in this deployment's catalogue.`);
		}
	}
	await writeTranscriptionModel(model);
	logger.info({ model, admin: admin.email }, "transcription_model_changed");
	return json(await status(locals.token));
};
