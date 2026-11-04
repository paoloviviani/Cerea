/**
 * Administration -> Agent auto-approval (ADR 0107 section 2): the reviewer's settings.
 * Administrator only. Saving settings that turn the reviewer on, with a changed model, threshold or
 * instructions, needs a passing "Test on the standard cases" for exactly those values.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireAdmin } from "$lib/server/admin";
import { logger } from "$lib/server/logger";
import {
	autoPermissionsEnabled,
	getAgentReviewSettings,
	needsPassingTest,
	normalize,
	reviewTester,
	saveAgentReviewSettings,
	SettingsInvalid,
} from "$lib/server/agentReview";
import { probeDecisionModels } from "$lib/server/agentReviewModels";
import { PERMISSION_CLASSES } from "$lib/types/machineProtocol";
import { INSTRUCTIONS_MAX } from "$lib/types/AgentReview";

const answerer = z.enum(["you", "reviewer"]);
const body = z.object({
	enabled: z.boolean(),
	decisionModelId: z.string().trim().max(200).nullable(),
	threshold: z.number(),
	instructions: z.string().max(INSTRUCTIONS_MAX + 200),
	perClass: z.record(z.enum(PERMISSION_CLASSES), answerer).optional(),
	maxPerHourPerMachine: z.number().int().min(1).max(10_000),
});

async function view(token: string | undefined) {
	const settings = await getAgentReviewSettings();
	const probe = await probeDecisionModels(token);
	const shown = { ...settings, testedFingerprint: undefined };
	return {
		settings: shown,
		killSwitchOn: !autoPermissionsEnabled(),
		decisionModels: probe.models,
		catalogue: probe.configured ? (probe.reachable ? "ok" : "unreachable") : "no_gateway",
		/** Whether the save-time test exists in this build; the save is gated on it only then. */
		testAvailable: reviewTester() !== null,
		testPassed: settings.testedFingerprint !== null && settings.testedFingerprint !== undefined,
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json(await view(locals.token));
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		error(400, "Send the reviewer's settings: " + parsed.error.issues[0]?.message);
	const saved = await getAgentReviewSettings();
	const next = normalize({ ...parsed.data, instructions: parsed.data.instructions.trim() });
	if (needsPassingTest(saved, next)) {
		error(409, 'Run "Test on the standard cases" on these settings first; it must pass.');
	}
	if (next.enabled && next.decisionModelId) {
		const probe = await probeDecisionModels(locals.token);
		if (probe.reachable && !probe.models.includes(next.decisionModelId)) {
			error(400, `${next.decisionModelId} is not a decision model in this deployment's catalogue.`);
		}
	}
	try {
		await saveAgentReviewSettings(parsed.data, {
			testedFingerprint: saved.testedFingerprint ?? null,
		});
	} catch (err) {
		if (err instanceof SettingsInvalid) error(400, err.message);
		throw err;
	}
	// Who and what changed, never the text.
	logger.info(
		{
			admin: admin.email,
			enabled: next.enabled,
			model: next.decisionModelId,
			threshold: next.threshold,
		},
		"agent_review_settings_changed"
	);
	return json(await view(locals.token));
};
