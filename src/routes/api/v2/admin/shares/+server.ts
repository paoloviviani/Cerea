/**
 * Public artifact links, the administrator's side (ADR 0120): every link in the
 * deployment, and the one deployment-wide switch. Administrator only (the
 * gateway's answer, `requireAdmin`).
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireAdmin } from "$lib/server/admin";
import { logger } from "$lib/server/logger";
import { listAllShares } from "$lib/server/sharing/shares";
import { setSharingEnabled, sharingEnabled, sharingEnvDefault } from "$lib/server/sharing/settings";
import { sharedOnAppOrigin } from "$lib/server/sharing/urls";

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json({
		enabled: await sharingEnabled(),
		envDefault: sharingEnvDefault(),
		onAppOrigin: sharedOnAppOrigin(),
		data: await listAllShares(),
	});
};

const body = z.object({ enabled: z.boolean() });

export const PATCH: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Say whether sharing is on: { enabled: true | false }.");
	const before = await sharingEnabled();
	await setSharingEnabled(parsed.data.enabled);
	logger.info(
		{ audit: "artifact_share", from: before, to: parsed.data.enabled, admin: admin.email },
		"artifact_sharing_toggled"
	);
	return json({ enabled: await sharingEnabled() });
};
