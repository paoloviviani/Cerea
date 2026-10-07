import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { config } from "$lib/server/config";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { defaultModel, models, validateModel } from "$lib/server/models";
import { findCustomModel, ownerFilter } from "$lib/server/customModels";
import { isCustomModelId } from "$lib/utils/customModelId";
import { GLOBAL_SYSTEM_PROMPT_MAX } from "$lib/types/CustomModel";
import { DEFAULT_SETTINGS, type SettingsEditable } from "$lib/types/Settings";
import { resolveStreamingMode } from "$lib/utils/messageUpdates";
import { parseAccent, parseNeutral } from "$lib/utils/palettes";
import { z } from "zod";
import { paletteFields, palettePatch } from "$lib/server/paletteSettings";

const settingsSchema = z.object({
	shareConversationsWithModelAuthors: z
		.boolean()
		.default(DEFAULT_SETTINGS.shareConversationsWithModelAuthors),
	webSearchEnabled: z.boolean().optional(),
	// Absent = `manual`. See the field doc in $lib/types/Settings.
	toolApprovalPolicy: z.enum(["always-allow", "manual"]).optional(),
	// Off by default and stored as absent: opt-in to letting the code
	// sandbox's micropip reach the public PyPI index, on top of the
	// vendored same-origin wheels every deployment serves. An admin
	// kill-switch can additionally force this unavailable regardless of
	// what's stored (see FeatureFlags.pyodidePyPiInstallAllowed).
	pyodidePyPiInstallEnabled: z.boolean().optional(),
	// Off by default and stored as absent: the person's opt-in to keeping
	// standing facts about themselves. The deployment flag
	// (CHAT_MEMORY_ENABLED) can withdraw the feature over the top of it.
	memoryEnabled: z.boolean().optional(),
	welcomeModalSeen: z.boolean().optional(),
	mlInternOnboardingSeen: z.boolean().optional(),
	activeModel: z.string().default(DEFAULT_SETTINGS.activeModel),
	// Unknown keys are stripped, so an old client still posting the retired
	// per-model `customPrompts` / `customPromptsEnabled` is ignored, not refused.
	globalSystemPrompt: z.string().max(GLOBAL_SYSTEM_PROMPT_MAX).optional(),
	multimodalOverrides: z.record(z.boolean()).default({}),
	toolsOverrides: z.record(z.boolean()).default({}),
	artifactsOverrides: z.record(z.boolean()).default({}),
	providerOverrides: z.record(z.string()).default({}),
	reasoningEffortOverrides: z.record(z.enum(["low", "medium", "high"])).default({}),
	reasoningOverrides: z.record(z.boolean()).default({}),
	streamingMode: z.enum(["raw", "smooth"]).optional(),
	directPaste: z.boolean().default(false),
	hapticsEnabled: z.boolean().default(true),
	hidePromptExamples: z.record(z.boolean()).default({}),
	billingOrganization: z.string().optional(),
	...paletteFields,
});

export const GET: RequestHandler = async ({ locals }) => {
	requireAuth(locals);
	const settings = await collections.settings.findOne(authCondition(locals));

	// Empty catalogue: `validateModel`/`defaultModel` degrade (see models.ts),
	// so there's no id to fall back to yet — leave the stored value alone
	// until the operator adds a model and the TTL refresh picks it up.
	//
	// A custom model is a valid default when it is this person's own; one that
	// has gone (deleted behind the app's back) resets like any retired model.
	const activeIsCustom = isCustomModelId(settings?.activeModel);
	const activeValid = activeIsCustom
		? Boolean(await findCustomModel(ownerFilter(locals), settings?.activeModel))
		: validateModel(models).safeParse(settings?.activeModel).success;
	if (defaultModel && settings && !activeValid) {
		settings.activeModel = defaultModel.id;
		await collections.settings.updateOne(authCondition(locals), {
			$set: { activeModel: defaultModel.id },
		});
	}

	// if the model is unlisted, set the active model to the default model
	if (
		defaultModel &&
		settings?.activeModel &&
		models.find((m) => m.id === settings?.activeModel)?.unlisted === true
	) {
		settings.activeModel = defaultModel.id;
		await collections.settings.updateOne(authCondition(locals), {
			$set: { activeModel: defaultModel.id },
		});
	}

	const streamingMode = resolveStreamingMode(settings ?? {});

	return superjsonResponse({
		webSearchEnabled: settings?.webSearchEnabled ?? undefined,
		toolApprovalPolicy: settings?.toolApprovalPolicy ?? undefined,
		pyodidePyPiInstallEnabled: settings?.pyodidePyPiInstallEnabled ?? undefined,
		memoryEnabled: settings?.memoryEnabled ?? undefined,
		welcomeModalSeen: !!settings?.welcomeModalSeenAt,
		welcomeModalSeenAt: settings?.welcomeModalSeenAt ?? null,
		mlInternOnboardingSeen: !!settings?.mlInternOnboardingSeenAt,

		activeModel: settings?.activeModel ?? DEFAULT_SETTINGS.activeModel,
		streamingMode,
		directPaste: settings?.directPaste ?? DEFAULT_SETTINGS.directPaste,
		hapticsEnabled: settings?.hapticsEnabled ?? DEFAULT_SETTINGS.hapticsEnabled,
		hidePromptExamples: settings?.hidePromptExamples ?? DEFAULT_SETTINGS.hidePromptExamples,
		shareConversationsWithModelAuthors:
			settings?.shareConversationsWithModelAuthors ??
			DEFAULT_SETTINGS.shareConversationsWithModelAuthors,

		globalSystemPrompt: settings?.globalSystemPrompt ?? undefined,
		// On HuggingChat, tool/multimodal capability comes from the upstream router,
		// so we hide any per-user overrides (existing or new) instead of letting them apply.
		multimodalOverrides: config.isHuggingChat ? {} : (settings?.multimodalOverrides ?? {}),
		toolsOverrides: config.isHuggingChat ? {} : (settings?.toolsOverrides ?? {}),
		// Not provider-determined, so user-editable even on HuggingChat
		artifactsOverrides: settings?.artifactsOverrides ?? {},
		providerOverrides: settings?.providerOverrides ?? {},
		reasoningEffortOverrides: settings?.reasoningEffortOverrides ?? {},
		reasoningOverrides: config.isHuggingChat ? {} : (settings?.reasoningOverrides ?? {}),
		billingOrganization: settings?.billingOrganization ?? undefined,
		accent: parseAccent(settings?.accent) ?? DEFAULT_SETTINGS.accent,
		neutral: parseNeutral(settings?.neutral) ?? DEFAULT_SETTINGS.neutral,
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAuth(locals);
	const body: unknown = await request.json().catch(() => undefined);
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ message: "Expected a JSON object of settings." }, { status: 400 });
	}
	// GET reports an unset field as null (superjson's plain-JSON form of
	// undefined), so a null here means "unset", the same as leaving it out:
	// GET's output posts back as-is.
	const present = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null));
	const parsed = settingsSchema.safeParse(present);
	if (!parsed.success) {
		return Response.json(
			{ message: "Invalid settings.", issues: parsed.error.issues },
			{ status: 400 }
		);
	}
	const { welcomeModalSeen, mlInternOnboardingSeen, accent, neutral, ...parsedSettings } =
		parsed.data;
	const streamingMode = resolveStreamingMode(parsedSettings);

	if (config.isHuggingChat) {
		parsedSettings.multimodalOverrides = {};
		parsedSettings.toolsOverrides = {};
		parsedSettings.reasoningOverrides = {};
	}

	const settings = {
		...parsedSettings,
		streamingMode,
	} satisfies SettingsEditable;

	await collections.settings.updateOne(
		authCondition(locals),
		{
			$set: {
				...settings,
				...palettePatch({ accent, neutral }),
				...(welcomeModalSeen && { welcomeModalSeenAt: new Date() }),
				...(mlInternOnboardingSeen && { mlInternOnboardingSeenAt: new Date() }),
				updatedAt: new Date(),
			},
			$setOnInsert: {
				createdAt: new Date(),
			},
		},
		{ upsert: true }
	);

	return new Response();
};
