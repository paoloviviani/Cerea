/**
 * Workspace -> Agents (ADR 0109): the caller's own auto-approval settings. The settings of the
 * session's user only, never another's; saving is never gated on the standard-case test.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { logger } from "$lib/server/logger";
import {
	autoPermissionsEnabled,
	getDeploymentReviewEnabled,
	getUserReviewSettings,
	saveUserReviewSettings,
	SettingsInvalid,
} from "$lib/server/agentReview";
import { probeDecisionModels } from "$lib/server/agentReviewModels";
import { resendAutoMap } from "$lib/server/review/resend";
import { PERMISSION_CLASSES } from "$lib/types/machineProtocol";
import { INSTRUCTIONS_MAX } from "$lib/types/AgentReview";

const body = z.object({
	enabled: z.boolean(),
	decisionModelId: z.string().trim().max(200).nullable(),
	threshold: z.number(),
	instructions: z.string().max(INSTRUCTIONS_MAX + 200),
	perClass: z.record(z.enum(PERMISSION_CLASSES), z.enum(["run", "reviewer", "you"])).optional(),
});

async function view(userId: import("mongodb").ObjectId, token: string | undefined) {
	const settings = await getUserReviewSettings(userId);
	const probe = await probeDecisionModels(token);
	return {
		settings: {
			enabled: settings.enabled,
			decisionModelId: settings.decisionModelId,
			threshold: settings.threshold,
			instructions: settings.instructions,
			perClass: settings.perClass,
		},
		/** The administrator's switch: while off, Auto has no reviewer whatever is set here. */
		deploymentEnabled: await getDeploymentReviewEnabled(),
		killSwitchOn: !autoPermissionsEnabled(),
		decisionModels: probe.models,
		catalogue: probe.configured ? (probe.reachable ? "ok" : "unreachable") : "no_gateway",
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	await requireCodeAgents(locals);
	if (!locals.user) error(401, "Login required");
	return json(await view(locals.user._id, locals.token));
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	await requireCodeAgents(locals);
	if (!locals.user) error(401, "Login required");
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		error(400, "Send your reviewer settings: " + parsed.error.issues[0]?.message);
	if (parsed.data.decisionModelId) {
		const probe = await probeDecisionModels(locals.token);
		if (probe.reachable && !probe.models.includes(parsed.data.decisionModelId)) {
			error(400, `${parsed.data.decisionModelId} is not a decision model you can use.`);
		}
	}
	try {
		await saveUserReviewSettings(locals.user._id, parsed.data);
	} catch (err) {
		if (err instanceof SettingsInvalid) error(400, err.message);
		throw err;
	}
	// The new rows reach the user's sessions that are on Auto now (best effort, never fails the save).
	await resendAutoMap(locals.user._id);
	// Who and what changed, never the text.
	logger.info(
		{
			user: String(locals.user._id),
			enabled: parsed.data.enabled,
			model: parsed.data.decisionModelId,
			threshold: parsed.data.threshold,
		},
		"agent_review_user_settings_changed"
	);
	return json(await view(locals.user._id, locals.token));
};
