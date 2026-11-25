/**
 * Where MCP Apps may be shown: off, only the deployment's connectors, or all (see
 * `appsMode.ts`). Site-wide, administrator only. Stored like the dictation mode: the
 * environment's `MCP_APPS` is the default and a saved value overrides it.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { requireAdmin } from "$lib/server/admin";
import { appsMode } from "$lib/server/mcp/appsMode";
import { APPS_MODES } from "$lib/server/mcp/appsMode.parse";

const body = z.object({ mode: z.enum(APPS_MODES) });

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json({
		mode: appsMode(),
		available: APPS_MODES,
		configurable: config.ENABLE_CONFIG_MANAGER === "true",
	});
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	if (config.ENABLE_CONFIG_MANAGER !== "true") {
		error(
			409,
			"This deployment stores configuration in the environment only " +
				"(ENABLE_CONFIG_MANAGER is not true): set MCP_APPS there instead."
		);
	}
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, `Pick one of: ${APPS_MODES.join(", ")}.`);
	const before = appsMode();
	await config.set("MCP_APPS", parsed.data.mode);
	logger.info({ from: before, to: parsed.data.mode, admin: admin.email }, "mcp_apps_mode_changed");
	return json({ mode: appsMode() });
};
