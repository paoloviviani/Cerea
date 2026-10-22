/**
 * Whether the assistant may hand work to sub-agents (`delegate`, `research`).
 * Site-wide, administrator only.
 *
 * Stored in the chat's own `config` collection like the dictation switch: what
 * the chat offers is a product decision. Who may change it is the gateway's
 * answer (`requireAdmin`).
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { requireAdmin } from "$lib/server/admin";
import { delegationEnabled } from "$lib/server/delegation";

const body = z.object({ enabled: z.boolean() });

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json({
		enabled: delegationEnabled(),
		configurable: config.ENABLE_CONFIG_MANAGER === "true",
	});
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	if (config.ENABLE_CONFIG_MANAGER !== "true") {
		error(
			409,
			"This deployment stores configuration in the environment only " +
				"(ENABLE_CONFIG_MANAGER is not true): set CHAT_DELEGATION there instead."
		);
	}
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		error(400, "Send { enabled: true } or { enabled: false }.");
	}
	const before = delegationEnabled();
	await config.set("CHAT_DELEGATION", parsed.data.enabled ? "true" : "false");
	// Logged with who and from what: sub-agents spend model calls and use
	// connector tools on their own, which somebody will want to date.
	logger.info(
		{ from: before, to: parsed.data.enabled, admin: admin.email },
		"delegation_enabled_changed"
	);
	return json({ enabled: delegationEnabled() });
};
