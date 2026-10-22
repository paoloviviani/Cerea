import { collections } from "$lib/server/database";
import { z } from "zod";
import { locationSettingsFields } from "$lib/utils/location";
import { paletteFields, palettePatch } from "$lib/server/paletteSettings";
import { authCondition } from "$lib/server/auth";
import { GLOBAL_SYSTEM_PROMPT_MAX } from "$lib/types/CustomModel";
import { DEFAULT_SETTINGS, type SettingsEditable } from "$lib/types/Settings";
import { resolveStreamingMode } from "$lib/utils/messageUpdates";
import type { RequestHandler } from "@sveltejs/kit";

const settingsSchema = z.object({
	// On by default for new accounts (DEFAULT_SETTINGS); the field is the
	// user's consent to web search, and the tool it enables also needs the
	// console's search tier. Absent on older documents still resolves as off,
	// and a missing search backend withholds the tool rather than failing.
	webSearchEnabled: z.boolean().optional(),
	// Absent means `manual` (every gated tool call asks). The v2 settings
	// endpoint (`api/v2/user/settings`) carries this same field — the client
	// store saves through THIS route, so a field added only there is
	// silently stripped here and never persists.
	toolApprovalPolicy: z.enum(["always-allow", "manual"]).optional(),
	// Off by default and stored as absent: opt-in to the code sandbox's
	// micropip reaching the public PyPI index, on top of the vendored
	// same-origin wheels. An admin kill-switch can force this unavailable
	// regardless of what's stored here.
	pyodidePyPiInstallEnabled: z.boolean().optional(),
	// Off by default and stored as absent: the person's opt-in to keeping
	// standing facts about themselves. The deployment flag
	// (CHAT_MEMORY_ENABLED) can withdraw the feature over the top of it.
	memoryEnabled: z.boolean().optional(),
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
});

export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await request.json();

	const { accent, neutral, ...parsedSettings } = settingsSchema.parse(body);
	const streamingMode = resolveStreamingMode(parsedSettings);

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
				updatedAt: new Date(),
			},
			$setOnInsert: {
				createdAt: new Date(),
			},
		},
		{
			upsert: true,
		}
	);
	// return ok response
	return new Response();
};
