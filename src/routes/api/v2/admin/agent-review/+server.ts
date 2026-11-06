/**
 * Administration -> Agents (ADR 0109): the deployment's one switch, "Auto may use a reviewer here".
 * Each user chooses their own decision model, threshold, instructions and rows in Workspace ->
 * Agents. Administrator only.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireAdmin } from "$lib/server/admin";
import { logger } from "$lib/server/logger";
import {
	autoPermissionsEnabled,
	getDeploymentReviewEnabled,
	setDeploymentReviewEnabled,
} from "$lib/server/agentReview";

const body = z.object({ enabled: z.boolean() });

async function view() {
	return { enabled: await getDeploymentReviewEnabled(), killSwitchOn: !autoPermissionsEnabled() };
}

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json(await view());
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Send { enabled: true | false }.");
	await setDeploymentReviewEnabled(parsed.data.enabled);
	logger.info({ admin: admin.email, enabled: parsed.data.enabled }, "agent_review_switch_changed");
	return json(await view());
};
