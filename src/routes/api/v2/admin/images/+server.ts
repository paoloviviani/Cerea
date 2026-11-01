/**
 * Image generation, chosen under Administration -> Assistant -> Images: the
 * model that draws, and whether each generation waits for the user's approval.
 * Its own route, behind the same administrator gate as the rest of the admin area.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";

import { requireAdmin } from "$lib/server/admin";
import { logger } from "$lib/server/logger";
import {
	envImageModel,
	imageAskFirst,
	listImageModels,
	probeImageModels,
	resolveImage,
	storedImageModel,
	writeImageConfig,
} from "$lib/server/imageGeneration";

async function status(token: string | undefined) {
	const probe = token
		? await probeImageModels(token)
		: { models: [] as string[], reachable: false, configured: false };
	const available = probe.models;
	const stored = await storedImageModel().catch(() => null);
	const resolved = resolveImage({
		storedModel: stored,
		envModel: envImageModel(),
		candidates: available,
	});
	// Whether images work for the administrator's own account: the resolved
	// model must be in the catalogue this token sees (the gateway console
	// grants models per user).
	const account: {
		available: boolean;
		reason: "no_gateway" | "gateway_unreachable" | "no_model" | "not_granted" | null;
	} =
		!token || !probe.configured
			? { available: false, reason: "no_gateway" }
			: !probe.reachable
				? { available: false, reason: "gateway_unreachable" }
				: !resolved.model
					? { available: false, reason: "no_model" }
					: !available.includes(resolved.model)
						? { available: false, reason: "not_granted" }
						: { available: true, reason: null };
	return {
		account_available: account.available,
		account_reason: account.reason,
		/** What would draw now, and why. */
		model: resolved.model,
		source: resolved.source,
		/** The administrator's own choice, or null for the deployment default. */
		stored_model: stored,
		env_model: envImageModel(),
		available_models: available,
		/** Whether each generation waits for the user's approval card. */
		ask_first: await imageAskFirst(),
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json(await status(locals.token));
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	const body = (await request.json().catch(() => null)) as {
		model?: unknown;
		ask_first?: unknown;
	} | null;
	if (!body || typeof body !== "object" || !("model" in body || "ask_first" in body)) {
		error(
			400,
			"Send {model: <name> | null} and/or {ask_first: true | false}. A null model means the deployment default."
		);
	}
	const patch: { model?: string | null; askFirst?: boolean } = {};
	if ("model" in body) {
		const raw = body.model;
		if (raw !== null && typeof raw !== "string") {
			error(400, "model must be a model name or null.");
		}
		const model = typeof raw === "string" ? raw.trim() || null : null;
		if (model) {
			const available = locals.token ? await listImageModels(locals.token) : [];
			if (!available.includes(model)) {
				error(400, `${model} is not an image model in this deployment's catalogue.`);
			}
		}
		patch.model = model;
	}
	if ("ask_first" in body) {
		if (typeof body.ask_first !== "boolean") error(400, "ask_first must be true or false.");
		patch.askFirst = body.ask_first;
	}
	await writeImageConfig(patch);
	logger.info({ ...patch, admin: admin.email }, "image_generation_settings_changed");
	return json(await status(locals.token));
};
