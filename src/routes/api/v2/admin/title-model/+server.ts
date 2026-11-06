/**
 * The model that writes chat titles, chosen under Administration -> Assistant
 * -> Model for titles. Site-wide, administrator only; "automatic" (null) means
 * TASK_MODEL, else a non-reasoning model, else the conversation's own.
 *
 * Stored in the chat's own `config` collection like the instructions.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { requireAdmin } from "$lib/server/admin";
import { storedTitleModel } from "$lib/server/titleModel";

async function catalogue() {
	const { models } = await import("$lib/server/models");
	return models.map((m) => ({
		id: m.id,
		name: m.displayName || m.name || m.id,
		reasoning: m.supportsReasoning === true,
	}));
}

async function status() {
	return {
		model: storedTitleModel(),
		task_model: config.TASK_MODEL?.trim() || null,
		available_models: await catalogue(),
		configurable: config.ENABLE_CONFIG_MANAGER === "true",
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json(await status());
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	if (config.ENABLE_CONFIG_MANAGER !== "true") {
		error(
			409,
			"This deployment stores configuration in the environment only " +
				"(ENABLE_CONFIG_MANAGER is not true): set TITLE_MODEL there instead."
		);
	}
	const body = (await request.json().catch(() => null)) as { model?: unknown } | null;
	if (!body || typeof body !== "object" || !("model" in body)) {
		error(400, "Send {model: <model id> | null}. A null model means automatic.");
	}
	const raw = body.model;
	if (raw !== null && typeof raw !== "string") error(400, "model must be a model id or null.");
	const model = typeof raw === "string" ? raw.trim() : "";
	if (model && !(await catalogue()).some((m) => m.id === model)) {
		error(400, `${model} is not a chat model in this deployment's catalogue.`);
	}
	await config.set("TITLE_MODEL", model);
	logger.info({ model: model || null, admin: admin.email }, "title_model_changed");
	return json(await status());
};
