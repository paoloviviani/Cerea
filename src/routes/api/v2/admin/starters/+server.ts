/**
 * The switch for the starter suggestions on a new chat. Site-wide,
 * administrator only, off by default. Stored in the chat's own `config`
 * collection like the other admin switches.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { config } from "$lib/server/config";
import { requireAdmin } from "$lib/server/admin";
import { starterSuggestionsEnabled } from "$lib/server/starterSuggestions";

const body = z.object({ enabled: z.boolean() });

const current = () => ({ enabled: starterSuggestionsEnabled() });

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json({ ...current(), configurable: config.ENABLE_CONFIG_MANAGER === "true" });
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	await requireAdmin(locals);
	if (config.ENABLE_CONFIG_MANAGER !== "true") {
		error(
			409,
			"This deployment stores configuration in the environment only " +
				"(ENABLE_CONFIG_MANAGER is not true): set STARTER_SUGGESTIONS there instead."
		);
	}
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Send { enabled }.");
	await config.set("STARTER_SUGGESTIONS", parsed.data.enabled ? "true" : "false");
	return json(current());
};
