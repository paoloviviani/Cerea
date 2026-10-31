/**
 * How the composer does dictation: browser, transcription model or off.
 * Site-wide, administrator only.
 *
 * Stored in the chat's own `config` collection like the fetch backend: what
 * the composer offers is a product decision. Who may change it is the
 * gateway's answer (`requireAdmin`).
 */

import { legacyTranscriptionConfigured } from "$lib/server/transcription";
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { requireAdmin } from "$lib/server/admin";
import { DICTATION_MODES, dictationMode } from "$lib/server/dictation";

const body = z.object({ mode: z.enum(DICTATION_MODES) });

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json({
		mode: dictationMode(),
		available: DICTATION_MODES,
		// The deprecated direct endpoint is set: the model option uses it.
		legacyTranscription: legacyTranscriptionConfigured(),
		configurable: config.ENABLE_CONFIG_MANAGER === "true",
	});
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	if (config.ENABLE_CONFIG_MANAGER !== "true") {
		error(
			409,
			"This deployment stores configuration in the environment only " +
				"(ENABLE_CONFIG_MANAGER is not true): set CHAT_DICTATION there instead."
		);
	}
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		error(400, `Pick one of: ${DICTATION_MODES.join(", ")}.`);
	}
	const before = dictationMode();
	await config.set("CHAT_DICTATION", parsed.data.mode);
	// Logged with who and from what: "browser" lets users' browsers send audio to
	// their vendor and "model" sends it to the provider, which somebody will want to date.
	logger.info({ from: before, to: parsed.data.mode, admin: admin.email }, "dictation_mode_changed");
	return json({ mode: dictationMode() });
};
