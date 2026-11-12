/**
 * Browser use (ADR 0116): the switch, the browser model, the budgets and the site lists.
 * Site-wide, administrator only, off by default.
 *
 * Stored in the chat's own `config` collection like the sub-agent switch. Who may change it is
 * the gateway's answer (`requireAdmin`); with `ENABLE_CONFIG_MANAGER` off the values can only be
 * set in the environment.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { requireAdmin } from "$lib/server/admin";
import { BROWSER_LIMITS, browserSettings } from "$lib/server/browser/settings";
import { isPublicSuffix, parseSiteList } from "$lib/server/browser/siteRules";

async function catalogue() {
	const { models } = await import("$lib/server/models");
	return models
		.filter((m) => m.supportsTools !== false)
		.map((m) => ({ id: m.id, name: m.displayName || m.name || m.id }));
}

async function status() {
	const settings = browserSettings();
	return {
		enabled: settings.enabled,
		model: settings.model || null,
		max_steps: settings.budgets.maxSteps,
		max_tokens: settings.budgets.maxTokens,
		max_seconds: settings.budgets.maxSeconds,
		sites_allow: settings.rules.allow,
		sites_deny: settings.rules.deny,
		limits: BROWSER_LIMITS,
		available_models: await catalogue(),
		configurable: config.ENABLE_CONFIG_MANAGER === "true",
	};
}

const number = (key: keyof typeof BROWSER_LIMITS) =>
	z.number().int().min(BROWSER_LIMITS[key].min).max(BROWSER_LIMITS[key].max);

const body = z.object({
	enabled: z.boolean(),
	/** A model id; null or empty means the chat's own model. */
	model: z.string().trim().nullable(),
	max_steps: number("maxSteps"),
	max_tokens: number("maxTokens"),
	max_seconds: number("maxSeconds"),
	sites_allow: z.array(z.string()).max(200),
	sites_deny: z.array(z.string()).max(200),
});

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
				"(ENABLE_CONFIG_MANAGER is not true): set the CHAT_BROWSER_* variables there instead."
		);
	}
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That is not a valid browser use setting.");
	}
	const input = parsed.data;
	const model = input.model ?? "";
	if (model && !(await catalogue()).some((m) => m.id === model)) {
		error(400, `${model} is not a chat model in this deployment's catalogue.`);
	}
	// A line that is not a host would silently vanish from the list; refuse it by name.
	for (const entry of [...input.sites_allow, ...input.sites_deny]) {
		// An entry may hold several, separated by commas or line breaks: every one is checked.
		for (const piece of entry.split(/[\n,]/)) {
			const text = piece.trim();
			if (!text || text.startsWith("#")) continue;
			const parsedPiece = parseSiteList(text);
			if (parsedPiece.length === 0) error(400, `'${text}' is not a site address.`);
			// `com` or `co.uk` would cover thousands of unrelated sites.
			if (isPublicSuffix(parsedPiece[0].replace(/^\*\./, ""))) {
				error(400, `'${text}' covers every site under it. Name a site, such as shop.example.com.`);
			}
		}
	}
	const allow = parseSiteList(input.sites_allow.join("\n"));
	const deny = parseSiteList(input.sites_deny.join("\n"));

	const before = browserSettings();
	await config.set("CHAT_BROWSER_ENABLED", input.enabled ? "true" : "false");
	await config.set("CHAT_BROWSER_MODEL", model);
	await config.set("CHAT_BROWSER_MAX_STEPS", String(input.max_steps));
	await config.set("CHAT_BROWSER_MAX_TOKENS", String(input.max_tokens));
	await config.set("CHAT_BROWSER_MAX_SECONDS", String(input.max_seconds));
	await config.set("CHAT_BROWSER_SITES_ALLOW", allow.join("\n"));
	await config.set("CHAT_BROWSER_SITES_DENY", deny.join("\n"));
	// Logged with who and from what: browsing acts on users' accounts, so somebody will want to date it.
	logger.info(
		{
			admin: admin.email,
			enabledFrom: before.enabled,
			enabledTo: input.enabled,
			model: model || null,
			allow: allow.length,
			deny: deny.length,
		},
		"browser_use_settings_changed"
	);
	return json(await status());
};
