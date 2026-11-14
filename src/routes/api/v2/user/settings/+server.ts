import type { RequestHandler } from "@sveltejs/kit";
import { guardAnonymousSettingsRow } from "$lib/server/anonymousSettings";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { defaultModel, models, validateModel } from "$lib/server/models";
import { isUnlistedForUsers } from "$lib/server/hiddenModels";
import { callerByokModels } from "$lib/server/visibleModels";
import { findCustomModel, ownerFilter } from "$lib/server/customModels";
import { isCustomModelId } from "$lib/utils/customModelId";
import { GLOBAL_SYSTEM_PROMPT_MAX } from "$lib/types/CustomModel";
import { DEFAULT_SETTINGS, type SettingsEditable } from "$lib/types/Settings";
import { resolveStreamingMode } from "$lib/utils/messageUpdates";
import { parseAccent, parseBackground, parseNeutral, parseSidebar } from "$lib/utils/palettes";
import { z } from "zod";
import { visibleAdminInstructions } from "$lib/server/adminInstructions";
import { locationSettingsFields } from "$lib/utils/location";
import { paletteFields, palettePatch } from "$lib/server/paletteSettings";
import { localeFields, localePatch } from "$lib/server/localeSettings";

const settingsSchema = z.object({
	// On by default for new accounts (DEFAULT_SETTINGS); absent on older
	// documents still resolves as off. The tool itself also needs the
	// console's search tier, so a missing backend withholds it.
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
	// Off by default and stored as absent: asks the gateway to send the hidden
	// values back with each answer, for the turn details.
	showRedactionValues: z.boolean().optional(),
	activeModel: z.string().default(DEFAULT_SETTINGS.activeModel),
	// Unknown keys are stripped, so an old client still posting the retired
	// per-model `customPrompts` / `customPromptsEnabled` is ignored, not refused.
	globalSystemPrompt: z.string().max(GLOBAL_SYSTEM_PROMPT_MAX).optional(),
	multimodalOverrides: z.record(z.boolean()).default({}),
	toolsOverrides: z.record(z.boolean()).default({}),
	artifactsOverrides: z.record(z.boolean()).default({}),
	reasoningEffortOverrides: z.record(z.enum(["low", "medium", "high"])).default({}),
	reasoningOverrides: z.record(z.boolean()).default({}),
	streamingMode: z.enum(["raw", "smooth"]).optional(),
	directPaste: z.boolean().default(false),
	hapticsEnabled: z.boolean().default(true),
	hidePromptExamples: z.record(z.boolean()).default({}),
	billingOrganization: z.string().optional(),
	...locationSettingsFields,
	...paletteFields,
	...localeFields,
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
	// A user's own-key model (`my/<name>`) is valid while it is in their gateway
	// list. If the gateway cannot be asked, leave the stored choice alone rather
	// than reset it over an outage.
	const activeIsOwn = Boolean(settings?.activeModel?.startsWith("my/"));
	const ownList = activeIsOwn ? await callerByokModels(locals) : [];
	const activeValid = activeIsCustom
		? Boolean(await findCustomModel(ownerFilter(locals), settings?.activeModel))
		: activeIsOwn
			? ownList === null || ownList.some((m) => m.id === settings?.activeModel)
			: validateModel(models).safeParse(settings?.activeModel).success;
	if (defaultModel && settings && !activeValid) {
		settings.activeModel = defaultModel.id;
		await collections.settings.updateOne(authCondition(locals), {
			$set: { activeModel: defaultModel.id },
		});
	}

	// if the model is unlisted, set the active model to the default model
	const activeEntry = models.find((m) => m.id === settings?.activeModel);
	if (
		defaultModel &&
		settings?.activeModel &&
		activeEntry &&
		isUnlistedForUsers(activeEntry, defaultModel.id)
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
		showRedactionValues: settings?.showRedactionValues ?? undefined,
		locationMode: settings?.locationMode ?? undefined,
		locationPlace: settings?.locationPlace ?? undefined,

		activeModel: settings?.activeModel ?? DEFAULT_SETTINGS.activeModel,
		streamingMode,
		directPaste: settings?.directPaste ?? DEFAULT_SETTINGS.directPaste,
		hapticsEnabled: settings?.hapticsEnabled ?? DEFAULT_SETTINGS.hapticsEnabled,
		hidePromptExamples: settings?.hidePromptExamples ?? DEFAULT_SETTINGS.hidePromptExamples,

		globalSystemPrompt: settings?.globalSystemPrompt ?? undefined,
		// The administrator's instructions, only while they are set and the
		// administrator left them visible: otherwise neither the text nor the
		// field is there.
		...visibleAdminInstructions(),
		multimodalOverrides: settings?.multimodalOverrides ?? {},
		toolsOverrides: settings?.toolsOverrides ?? {},
		artifactsOverrides: settings?.artifactsOverrides ?? {},
		reasoningEffortOverrides: settings?.reasoningEffortOverrides ?? {},
		reasoningOverrides: settings?.reasoningOverrides ?? {},
		billingOrganization: settings?.billingOrganization ?? undefined,
		accent: parseAccent(settings?.accent) ?? DEFAULT_SETTINGS.accent,
		neutral: parseNeutral(settings?.neutral) ?? DEFAULT_SETTINGS.neutral,
		sidebar: parseSidebar(settings?.sidebar) ?? DEFAULT_SETTINGS.sidebar,
		background: parseBackground(settings?.background) ?? DEFAULT_SETTINGS.background,
		locale: settings?.locale ?? undefined,
	});
};

export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
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
	const { accent, neutral, sidebar, background, locale, ...parsedSettings } = parsed.data;
	const streamingMode = resolveStreamingMode(parsedSettings);

	const settings = {
		...parsedSettings,
		streamingMode,
	} satisfies SettingsEditable;

	await guardAnonymousSettingsRow(locals, getClientAddress);
	await collections.settings.updateOne(
		authCondition(locals),
		{
			$set: {
				...settings,
				...palettePatch({ accent, neutral, sidebar, background }),
				...localePatch({ locale }),
				updatedAt: new Date(),
			},
			$setOnInsert: {
				createdAt: new Date(),
			},
		},
		{ upsert: true }
	);

	// Switching personal memory off must stop it reaching chats already under way: their frozen
	// snapshot of it (and any tail blocks quoting it) is dropped, and the next turn rebuilds.
	if (parsedSettings.memoryEnabled === false && locals.user) {
		const { dropPersonalMemoryFromChats } = await import("$lib/server/memory/service");
		await dropPersonalMemoryFromChats(locals.user._id).catch(() => undefined);
	}

	return new Response();
};
