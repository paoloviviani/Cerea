/**
 * The organisation's default slide look (theme, accent, logo), chosen under
 * Administration -> Assistant -> Slides. Site-wide, administrator only. Off
 * (all empty) until saved; decks still override it in their front matter.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { requireAdmin } from "$lib/server/admin";
import { slideDefaults } from "$lib/server/slideDefaults";
import { sanitizeOrgDefaults } from "$lib/utils/slides/themes";

const status = () => ({
	defaults: slideDefaults(),
	configurable: config.ENABLE_CONFIG_MANAGER === "true",
});

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json(status());
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	if (config.ENABLE_CONFIG_MANAGER !== "true") {
		error(
			409,
			"This deployment stores configuration in the environment only " +
				"(ENABLE_CONFIG_MANAGER is not true): set CHAT_SLIDES_DEFAULTS there instead."
		);
	}
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object") {
		error(400, "Send {theme?, accent?, logo?}; empty values turn the default off.");
	}
	const clean = sanitizeOrgDefaults(body);
	// A value that was sent but did not validate is an error, not a silent drop
	for (const key of ["theme", "accent", "logo"] as const) {
		const sent = body[key];
		if (typeof sent === "string" && sent.trim() !== "" && clean[key] === undefined) {
			error(400, `${key} is not valid.`);
		}
	}
	await config.set("CHAT_SLIDES_DEFAULTS", Object.keys(clean).length ? JSON.stringify(clean) : "");
	logger.info(
		{
			admin: admin.email,
			theme: clean.theme ?? null,
			accent: clean.accent ?? null,
			logo: !!clean.logo,
		},
		"slide_defaults_changed"
	);
	return json(status());
};
