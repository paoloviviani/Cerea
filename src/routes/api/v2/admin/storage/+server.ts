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
	MAX_ARTIFACT_VERSIONS_LIMIT,
	maxArtifactVersions,
	maxVersionsEnvDefault,
	maxVersionsOverridden,
	setMaxArtifactVersions,
} from "$lib/server/artifactVersions/settings";
import { requestFullVersionSweep } from "$lib/server/artifactVersions/prune";
import {
	DEFAULT_RETENTION_DAYS,
	MAX_RETENTION_DAYS,
	deliverableStorageSummary,
	fileRetentionDays,
} from "$lib/server/execution/deliverables";

const days = z.coerce.number().int().min(0).max(MAX_RETENTION_DAYS);
const body = z
	.object({
		retentionDays: days.optional(),
		/** Versions kept per artifact: 0 is unlimited, null goes back to ARTIFACT_MAX_VERSIONS. */
		maxArtifactVersions: z
			.number()
			.int()
			.min(0)
			.max(MAX_ARTIFACT_VERSIONS_LIMIT)
			.nullable()
			.optional(),
	})
	.refine((b) => b.retentionDays !== undefined || b.maxArtifactVersions !== undefined);

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
		maxArtifactVersions: await maxArtifactVersions(),
		maxArtifactVersionsEnv: maxVersionsEnvDefault(),
		maxArtifactVersionsOverridden: await maxVersionsOverridden(),
		maxArtifactVersionsLimit: MAX_ARTIFACT_VERSIONS_LIMIT,
		...summary,
	});
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		error(
			400,
			`Days must be a whole number from 0 to ${MAX_RETENTION_DAYS}, and versions from 0 to ${MAX_ARTIFACT_VERSIONS_LIMIT}.`
		);
	}
	if (parsed.data.maxArtifactVersions !== undefined) {
		// Stored in the database like the sharing toggle, so it needs no config manager.
		const before = await maxArtifactVersions();
		await setMaxArtifactVersions(parsed.data.maxArtifactVersions);
		requestFullVersionSweep();
		logger.info(
			{ from: before, to: await maxArtifactVersions(), admin: admin.email },
			"artifact_max_versions_changed"
		);
	}
	if (parsed.data.retentionDays !== undefined) {
		if (config.ENABLE_CONFIG_MANAGER !== "true") {
			error(
				409,
				"This deployment stores configuration in the environment only " +
					"(ENABLE_CONFIG_MANAGER is not true): set CHAT_FILE_RETENTION_DAYS there instead."
			);
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
	}
	return json({
		retentionDays: fileRetentionDays(),
		maxArtifactVersions: await maxArtifactVersions(),
	});
};
