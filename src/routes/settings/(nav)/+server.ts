import { collections } from "$lib/server/database";
import { z } from "zod";
import { locationSettingsFields } from "$lib/utils/location";
import { paletteFields, palettePatch } from "$lib/server/paletteSettings";
import { localeFields, localePatch } from "$lib/server/localeSettings";
import { authCondition, loginEnabled } from "$lib/server/auth";
import { GLOBAL_SYSTEM_PROMPT_MAX } from "$lib/types/CustomModel";
import { DEFAULT_SETTINGS, type SettingsEditable } from "$lib/types/Settings";
import { resolveStreamingMode } from "$lib/utils/messageUpdates";
import { error, type RequestHandler } from "@sveltejs/kit";

/** Settings are a handful of flags per model; nothing legitimate comes near these. */
const SETTINGS_MAX_BODY_BYTES = 64 * 1024;
const SETTINGS_RECORD_MAX_KEYS = 500;
const ANON_SETTINGS_MAX_ROWS = 10_000;

function boundedRecord<V extends z.ZodTypeAny>(value: V) {
	return z
		.record(z.string().max(200), value)
		.refine((r) => Object.keys(r).length <= SETTINGS_RECORD_MAX_KEYS, {
			message: `at most ${SETTINGS_RECORD_MAX_KEYS} entries`,
		})
		.default({});
}

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
	activeModel: z.string().max(200).default(DEFAULT_SETTINGS.activeModel),
	// Unknown keys are stripped, so an old client still posting the retired
	// per-model `customPrompts` / `customPromptsEnabled` is ignored, not refused.
	globalSystemPrompt: z.string().max(GLOBAL_SYSTEM_PROMPT_MAX).optional(),
	multimodalOverrides: boundedRecord(z.boolean()),
	toolsOverrides: boundedRecord(z.boolean()),
	artifactsOverrides: boundedRecord(z.boolean()),
	reasoningEffortOverrides: boundedRecord(z.enum(["low", "medium", "high"])),
	reasoningOverrides: boundedRecord(z.boolean()),
	streamingMode: z.enum(["raw", "smooth"]).optional(),
	directPaste: z.boolean().default(false),
	hapticsEnabled: z.boolean().default(true),
	hidePromptExamples: boundedRecord(z.boolean()),
	billingOrganization: z.string().max(200).optional(),
	...locationSettingsFields,
	...paletteFields,
	...localeFields,
});

export const POST: RequestHandler = async ({ request, locals }) => {
	// A settings row belongs to a signed-in user. Where sign-in is configured an
	// anonymous write only mints orphan rows (audit M2), so it is refused. Where
	// it is not (anonymous deployments) the row is keyed by the session cookie,
	// which a client can mint at will: an existing row may be updated freely, a
	// new one only while the anonymous population is under a global cap (the
	// TTL index in database.ts sweeps the rest).
	if (!locals.user) {
		if (loginEnabled || !locals.sessionId) error(401, "Sign in to save settings");
		const mine = await collections.settings.countDocuments(authCondition(locals), { limit: 1 });
		if (!mine) {
			const anon = await collections.settings.countDocuments(
				{ sessionId: { $exists: true } },
				{ limit: ANON_SETTINGS_MAX_ROWS }
			);
			if (anon >= ANON_SETTINGS_MAX_ROWS) error(429, "Too many anonymous sessions");
		}
	}

	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > SETTINGS_MAX_BODY_BYTES) error(413, "Settings body too large");
	const text = await request.text();
	if (text.length > SETTINGS_MAX_BODY_BYTES) error(413, "Settings body too large");
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		error(400, "Invalid JSON");
	}

	const { accent, neutral, locale, ...parsedSettings } = settingsSchema.parse(body);
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
				...localePatch({ locale }),
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
