/**
 * Models hidden from users' pickers, chosen under Administration -> Assistant
 * -> Models hidden from the chat picker. Site-wide, administrator only.
 * Hidden models stay usable for internal tasks (titles) and in chats already
 * on them; the default model cannot be hidden.
 *
 * Stored in the chat's own `config` collection like the instructions.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { requireAdmin } from "$lib/server/admin";
import { hiddenModelIds } from "$lib/server/hiddenModels";

async function registry() {
	const { models, defaultModel } = await import("$lib/server/models");
	return { models, defaultId: defaultModel?.id };
}

async function status() {
	const { models, defaultId } = await registry();
	const hidden = new Set(hiddenModelIds());
	return {
		configurable: config.ENABLE_CONFIG_MANAGER === "true",
		models: models.map((m) => ({
			id: m.id,
			name: m.displayName || m.name || m.id,
			reasoning: m.supportsReasoning === true,
			hidden: hidden.has(m.id),
			// Unlisted by the environment's model overrides: hidden regardless.
			env_unlisted: m.unlisted === true,
			is_default: m.id === defaultId,
		})),
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
				"(ENABLE_CONFIG_MANAGER is not true): set HIDDEN_MODELS there instead."
		);
	}
	const body = (await request.json().catch(() => null)) as { hidden?: unknown } | null;
	if (!body || !Array.isArray(body.hidden) || body.hidden.some((x) => typeof x !== "string")) {
		error(400, "Send {hidden: [<model id>, ...]}.");
	}
	const { models, defaultId } = await registry();
	const requested = [...new Set((body.hidden as string[]).map((s) => s.trim()).filter(Boolean))];
	const known = new Set(models.map((m) => m.id));
	const stranger = requested.find((id) => !known.has(id));
	if (stranger) error(400, `${stranger} is not a chat model in this deployment's catalogue.`);
	if (defaultId && requested.includes(defaultId)) {
		error(
			400,
			`${defaultId} is the default model (the one users start on and fall back to) ` +
				"and cannot be hidden."
		);
	}
	await config.set("HIDDEN_MODELS", requested.join(","));
	logger.info({ hidden: requested, admin: admin.email }, "hidden_models_changed");
	return json(await status());
};
