/**
 * The administrator's instructions for every chat: the text, and whether
 * users can read it in Settings. Site-wide, administrator only.
 *
 * Stored in the chat's own `config` collection like the delegation switch.
 * `config.set` updates this process's copy at once and signals the others, so
 * the next turn uses what was saved.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { requireAdmin } from "$lib/server/admin";
import {
	ADMIN_INSTRUCTIONS_MAX,
	adminInstructions,
	adminInstructionsVisible,
} from "$lib/server/adminInstructions";

const body = z.object({
	instructions: z.string().trim().max(ADMIN_INSTRUCTIONS_MAX),
	visible: z.boolean(),
});

const current = () => ({
	instructions: adminInstructions(),
	visible: adminInstructionsVisible(),
});

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json({
		...current(),
		max: ADMIN_INSTRUCTIONS_MAX,
		configurable: config.ENABLE_CONFIG_MANAGER === "true",
	});
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	if (config.ENABLE_CONFIG_MANAGER !== "true") {
		error(
			409,
			"This deployment stores configuration in the environment only " +
				"(ENABLE_CONFIG_MANAGER is not true): set ADMIN_INSTRUCTIONS there instead."
		);
	}
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		error(
			400,
			`Send { instructions, visible }: instructions up to ${ADMIN_INSTRUCTIONS_MAX} characters.`
		);
	}
	// Two writes that are not atomic, so the order decides what a half-finished
	// save can leave behind. Visibility goes first: when hiding, a failure after
	// it leaves the old text hidden (safe), where text first would leave the
	// new text visible against the administrator's wish. When showing, a failure
	// leaves the old text shown, which is what it already was applying.
	await config.set("ADMIN_INSTRUCTIONS_VISIBLE", parsed.data.visible ? "true" : "false");
	await config.set("ADMIN_INSTRUCTIONS", parsed.data.instructions);
	// Who and how long, never the text: it can name internal policy.
	logger.info(
		{
			admin: admin.email,
			length: parsed.data.instructions.length,
			visible: parsed.data.visible,
		},
		"admin_instructions_changed"
	);
	return json(current());
};
