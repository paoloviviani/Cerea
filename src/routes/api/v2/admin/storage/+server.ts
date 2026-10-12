/**
 * How long files produced by code are kept. Site-wide, administrator only.
 *
 * Stored in the chat's own `config` collection, like the fetch backend: what
 * the chat keeps of its own output is a product decision, not the gateway's.
 * Who may change it is the gateway's answer (`requireAdmin` → `/v1/me`).
 *
 * `GET ?days=N` also reports how many stored files a retention of N days
 * would remove at the next sweep, so the screen can say what a shorter
 * period costs before anybody saves it.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { requireAdmin } from "$lib/server/admin";
import {
	DEFAULT_RETENTION_DAYS,
	MAX_RETENTION_DAYS,
	deliverableStorageSummary,
	fileRetentionDays,
} from "$lib/server/execution/deliverables";

const days = z.coerce.number().int().min(0).max(MAX_RETENTION_DAYS);
const body = z.object({ retentionDays: days });

export const GET: RequestHandler = async ({ locals, url }) => {
	await requireAdmin(locals);
	const current = fileRetentionDays();
	const asked = url.searchParams.get("days");
	const parsed = asked === null ? null : days.safeParse(asked);
	if (parsed && !parsed.success) {
		error(400, `Days must be a whole number from 0 to ${MAX_RETENTION_DAYS}.`);
	}
	const summary = await deliverableStorageSummary(parsed?.success ? parsed.data : current);
	return json({
		retentionDays: current,
		defaultDays: DEFAULT_RETENTION_DAYS,
		maxDays: MAX_RETENTION_DAYS,
		configurable: config.ENABLE_CONFIG_MANAGER === "true",
		...summary,
	});
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	if (config.ENABLE_CONFIG_MANAGER !== "true") {
		error(
			409,
			"This deployment stores configuration in the environment only " +
				"(ENABLE_CONFIG_MANAGER is not true): set CHAT_FILE_RETENTION_DAYS there instead."
		);
	}
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		error(400, `Days must be a whole number from 0 to ${MAX_RETENTION_DAYS}.`);
	}
	const before = fileRetentionDays();
	await config.set("CHAT_FILE_RETENTION_DAYS", String(parsed.data.retentionDays));
	// Logged with who and from what: a shorter period deletes files at the
	// next sweep, and "who made last month's documents disappear" is a
	// question somebody will ask.
	logger.info(
		{ from: before, to: parsed.data.retentionDays, admin: admin.email },
		"file_retention_changed"
	);
	return json({ retentionDays: fileRetentionDays() });
};
