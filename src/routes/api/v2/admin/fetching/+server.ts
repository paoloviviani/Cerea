/**
 * Which backend fetches a URL. Site-wide, administrator only.
 *
 * Stored in the chat's own `config` collection rather than the gateway,
 * because what the composer's URL button does is a product decision — the same
 * reasoning ADR 0062 used to put the knowledge pipeline in this admin console
 * rather than the platform console.
 *
 * Who may change it is still the gateway's answer (`requireAdmin` → `/v1/me`);
 * the chat has no opinion of its own about who administers this deployment
 * worth trusting.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { requireAdmin } from "$lib/server/admin";
import { FETCH_BACKENDS, configuredBackend } from "$lib/server/fetching";

const body = z.object({ backend: z.enum(FETCH_BACKENDS) });

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json({
		backend: configuredBackend(),
		available: FETCH_BACKENDS,
		// Said plainly, because "selected" and "working" are different and the
		// screen should not imply the second from the first.
		configurable: config.ENABLE_CONFIG_MANAGER === "true",
	});
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);

	if (config.ENABLE_CONFIG_MANAGER !== "true") {
		error(
			409,
			"This deployment stores configuration in the environment only " +
				"(ENABLE_CONFIG_MANAGER is not true), so this cannot be changed from here."
		);
	}

	const parsed = body.safeParse(await request.json());
	if (!parsed.success) {
		error(400, `Pick one of: ${FETCH_BACKENDS.join(", ")}.`);
	}

	await config.set("FETCH_BACKEND", parsed.data.backend);
	// Logged with who: this changes where every fetched page is rendered, and
	// "when did this start going through the browser" is a question somebody
	// asks while looking at a latency graph.
	logger.info({ backend: parsed.data.backend, admin: admin.email }, "fetch_backend_changed");

	return json({ backend: configuredBackend() });
};
