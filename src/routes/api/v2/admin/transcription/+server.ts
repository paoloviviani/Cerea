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
	probeTranscriptionModels,
	resolveTranscription,
	storedTranscriptionModel,
	writeTranscriptionModel,
} from "$lib/server/transcription";

async function status(token: string | undefined) {
	const probe = token
		? await probeTranscriptionModels(token)
		: { models: [] as string[], reachable: false };
	const available = probe.models;
	const stored = await storedTranscriptionModel().catch(() => null);
	const resolved = resolveTranscription({
		storedModel: stored,
		envModel: envTranscriptionModel(),
		candidates: available,
	});
	// Whether audio works for the administrator's own account: the resolved
	// model must be in the catalogue this token sees (the gateway console
	// grants models per user).
	const account: {
		available: boolean;
		reason: "gateway_unreachable" | "no_model" | "not_granted" | null;
	} = !probe.reachable
		? { available: false, reason: "gateway_unreachable" }
		: !resolved.model
			? { available: false, reason: "no_model" }
			: !available.includes(resolved.model)
				? { available: false, reason: "not_granted" }
				: { available: true, reason: null };
	return {
		account_available: account.available,
		/** Why not, when not: gateway_unreachable, no_model or not_granted. */
		account_reason: account.reason,
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
