/**
 * Speech to text through the gateway: `POST /v1/audio/transcriptions`, as the
 * signed-in user, metered per audio minute with their token (model access
 * groups and bill-to apply as for any other call).
 *
 * Two features use it. An audio **attachment** is transcribed once, at upload
 * (`files/uploadFile.ts`) — the same billing reasoning as OCR: never again per
 * turn — and **dictation** sends each recording through `/api/transcribe`.
 *
 * Which model: the administrator's choice (Knowledge screen, next to the
 * document reader), else `CHAT_TRANSCRIPTION_MODEL`, else the first
 * `kind: transcription` model the user may use (`resolveTranscription`).
 *
 * The older direct route (`TRANSCRIPTION_BASE_URL` + `TRANSCRIPTION_MODEL`,
 * the token sent to an endpoint of the operator's choosing) is deprecated. It
 * still serves dictation when it is the only thing configured, and logs one
 * deprecation line (`warnLegacyTranscription`); attachments never use it.
 */

import { createHash } from "node:crypto";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import { gateway, GatewayCallFailed, GatewayTimeout } from "$lib/server/gatewayServer";
import { logger } from "$lib/server/logger";
import type { ExtractionFailureKind } from "$lib/types/Message";

/** The gateway's own upload cap (`GATEWAY_TRANSCRIPTION__MAX_UPLOAD_BYTES`, 25 MB by default). */
export const TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
/** The gateway cap in minutes of ordinary (128 kbit/s, about 1 MB a minute) audio. */
export const TRANSCRIPTION_CAP_MINUTES = 25;
const TRANSCRIPTION_TIMEOUT_MS = 180_000;

// -- legacy direct route ------------------------------------------------------

/** The deprecated direct endpoint's base URL, or undefined. */
export function transcriptionBaseUrl(): string | undefined {
	const base = String(config.get("TRANSCRIPTION_BASE_URL") ?? "")
		.trim()
		.replace(/\/+$/, "");
	return base || undefined;
}

/** Whether the deprecated `TRANSCRIPTION_MODEL` + `TRANSCRIPTION_BASE_URL` pair is set. */
export function legacyTranscriptionConfigured(): boolean {
	return Boolean(config.get("TRANSCRIPTION_MODEL")) && transcriptionBaseUrl() !== undefined;
}

let warnedLegacy = false;
/** One deprecation line per process, the first time the legacy route is used. */
export function warnLegacyTranscription(): void {
	if (warnedLegacy) return;
	warnedLegacy = true;
	logger.warn(
		"transcription_legacy_config: TRANSCRIPTION_BASE_URL/TRANSCRIPTION_MODEL are deprecated and " +
			"still take precedence for dictation (sent direct, with the deployment's key, never the gateway) " +
			"even when CHAT_TRANSCRIPTION_MODEL is set. Remove the pair to use the gateway's " +
			"/v1/audio/transcriptions with each user's own token."
	);
}

export function resetLegacyWarning(): void {
	warnedLegacy = false;
}

// -- which model --------------------------------------------------------------

export type TranscriptionSource = "stored" | "env" | "first-available" | "none";

export interface TranscriptionResolution {
	model: string | null;
	source: TranscriptionSource;
}

/** The order, in one place: the admin's choice, then the env value, then the first model. */
export function resolveTranscription(options: {
	storedModel: string | null;
	envModel: string | null;
	candidates: string[];
}): TranscriptionResolution {
	const { storedModel, envModel, candidates } = options;
	if (storedModel) return { model: storedModel, source: "stored" };
	if (envModel) return { model: envModel, source: "env" };
	if (candidates[0]) return { model: candidates[0], source: "first-available" };
	return { model: null, source: "none" };
}

export function envTranscriptionModel(): string | null {
	return config.CHAT_TRANSCRIPTION_MODEL?.trim() || null;
}

/**
 * The administrator's choice: the Voice & audio screen's document, else the
 * Knowledge screen's field from the release that kept it there (the new one
 * wins; saving on the new screen unsets the old).
 */
export async function storedTranscriptionModel(): Promise<string | null> {
	const voice = await collections.voiceConfig.findOne({});
	const chosen = voice?.transcriptionModel?.trim();
	if (chosen) return chosen;
	const legacy = await collections.knowledgeConfig.findOne({});
	return legacy?.transcriptionModel?.trim() || null;
}

export async function writeTranscriptionModel(model: string | null): Promise<void> {
	await collections.voiceConfig.updateOne(
		{},
		{ $set: { transcriptionModel: model, updatedAt: new Date() } },
		{ upsert: true }
	);
	// The old home would otherwise bring back a choice that was just cleared.
	await collections.knowledgeConfig.updateMany({}, { $unset: { transcriptionModel: "" } });
}

/** Past this the catalogue probe gives up: the audio features stay off, the page does not wait. */
export const CATALOGUE_TIMEOUT_MS = 2000;

/** The `kind: transcription` models this token may use, straight from the gateway (empty on failure). */
export async function listTranscriptionModels(token: string): Promise<string[]> {
	// No gateway, no catalogue: nothing to ask (and nothing to warn about).
	if (!config.OPENAI_BASE_URL) return [];
	try {
		const answer = await gateway.get<{ data: { id: string; kind?: string }[] }>(
			token,
			"models?include=transcription",
			{ timeoutMs: CATALOGUE_TIMEOUT_MS }
		);
		return answer.data.filter((card) => card.kind === "transcription").map((card) => card.id);
	} catch (err) {
		logger.warn({ err }, "transcription_unavailable: could not list models");
		return [];
	}
}

const CACHE_MS = 30_000;
const listed = new Map<string, { at: number; ids: Promise<string[]> }>();

/** The same, remembered briefly per token — a failure too, so a slow gateway costs one wait, not one per page. */
export function transcriptionModelsFor(token: string, now = Date.now()): Promise<string[]> {
	const key = createHash("sha256").update(token).digest("hex");
	const hit = listed.get(key);
	if (hit && now - hit.at < CACHE_MS) return hit.ids;
	const ids = listTranscriptionModels(token);
	listed.set(key, { at: now, ids });
	if (listed.size > 500) {
		for (const [k, v] of listed) if (now - v.at >= CACHE_MS) listed.delete(k);
	}
	return ids;
}

export function clearTranscriptionModelCache(): void {
	listed.clear();
}

/** The model this user's audio is transcribed with, and why — or none. */
export async function resolveTranscriptionModel(token: string): Promise<TranscriptionResolution> {
	let storedModel: string | null = null;
	try {
		storedModel = await storedTranscriptionModel();
	} catch (err) {
		// A Mongo hiccup means "the default decides", not a failed upload.
		logger.warn({ err }, "transcription_config_unreadable");
	}
	const envModel = envTranscriptionModel();
	// The catalogue is only asked when nothing named a model.
	const candidates = storedModel || envModel ? [] : await transcriptionModelsFor(token);
	return resolveTranscription({ storedModel, envModel, candidates });
}

// -- the call -----------------------------------------------------------------

export interface TranscribeOptions {
	bytes: ArrayBuffer | Uint8Array;
	mime: string;
	filename: string;
	token: string | undefined;
	/** A model already resolved; resolved here from the token when absent. */
	model?: string | null;
	/** `billTo` header value passthrough (the group that pays, when chosen). */
	billHeaders?: Record<string, string>;
	language?: string;
	/** A cap below the gateway's: what the caller itself accepts (an attachment is 10 MB). */
	maxBytes?: number;
}

export type Transcription =
	| { ok: true; text: string; durationSeconds?: number; language?: string; model: string }
	| { ok: false; kind: ExtractionFailureKind; reason: string; status: number };

interface TranscriptionAnswer {
	text?: string;
	language?: string;
	duration?: number | string;
	usage?: { audio_duration_seconds?: number; seconds?: number };
}

/** Silence often comes back as dots; that is no transcript. */
function cleanText(text: string | undefined): string {
	const trimmed = (text ?? "").trim();
	return /^\.+$/.test(trimmed) ? "" : trimmed;
}

/**
 * `ok: false` result for a file past the cap, before anything is sent. The
 * minutes are the cap's, at about a megabyte a minute (an estimate, said as one).
 */
export function tooLongFailure(
	maxBytes = TRANSCRIPTION_MAX_BYTES
): Extract<Transcription, { ok: false }> {
	const mb = Math.floor(maxBytes / 1024 / 1024);
	return {
		ok: false,
		kind: "unsupported",
		status: 413,
		reason: `This recording is too long to transcribe here; up to about ${mb} minutes (${mb} MB) can be transcribed at once.`,
	};
}

/**
 * One transcription, as the calling user. Every failure comes back spelled out
 * rather than thrown: an attachment is kept either way.
 */
export async function transcribeAudio(options: TranscribeOptions): Promise<Transcription> {
	const { bytes, mime, filename, token } = options;
	if (!token) {
		return {
			ok: false,
			kind: "no-credential",
			status: 401,
			reason:
				"The audio cannot be transcribed because your sign-in is incomplete. Sign out and back in.",
		};
	}
	const cap = Math.min(options.maxBytes ?? TRANSCRIPTION_MAX_BYTES, TRANSCRIPTION_MAX_BYTES);
	if (bytes.byteLength > cap) return tooLongFailure(cap);

	const model = options.model ?? (await resolveTranscriptionModel(token)).model;
	if (!model) {
		return {
			ok: false,
			kind: "no-reader",
			status: 503,
			reason:
				"No transcription model is set up, so audio cannot be transcribed. An administrator can pick one on the Knowledge screen.",
		};
	}

	const form = new FormData();
	form.set("file", new Blob([bytes as BlobPart], { type: mime }), filename);
	form.set("model", model);
	// `verbose_json` carries the language and duration where the provider has them.
	form.set("response_format", "verbose_json");
	// A language code ("en", "pt-BR"); anything longer is not one.
	if (options.language) form.set("language", options.language.trim().slice(0, 16));

	try {
		const answer = await gateway.postForm<TranscriptionAnswer>(
			token,
			"audio/transcriptions",
			form,
			{
				timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
				headers: options.billHeaders,
			}
		);
		const text = cleanText(answer.text);
		const seconds = Number(answer.usage?.audio_duration_seconds ?? answer.duration);
		return {
			ok: true,
			text,
			model,
			...(Number.isFinite(seconds) && seconds > 0 ? { durationSeconds: seconds } : {}),
			...(answer.language ? { language: String(answer.language).slice(0, 16) } : {}),
		};
	} catch (err) {
		if (err instanceof GatewayTimeout) {
			logger.warn({ filename, model }, "transcription_timeout");
			return {
				ok: false,
				kind: "unreachable",
				status: 504,
				reason: `The transcription model ${model} took too long. Try a shorter recording.`,
			};
		}
		const status = err instanceof GatewayCallFailed ? err.status : 502;
		let kind: ExtractionFailureKind = "unreachable";
		let reason = "The transcription service could not be reached.";
		if (status === 413) return tooLongFailure(cap);
		if (status === 403) {
			kind = "refused";
			reason = `The transcription model ${model} isn't available to your groups.`;
		} else if (status === 429 || status >= 500) {
			reason = `The transcription model ${model} is unavailable right now (the provider answered ${status}).`;
		} else if (err instanceof GatewayCallFailed) {
			kind = "refused";
			reason = err.message || reason;
		}
		logger.warn({ filename, model, status, err }, "transcription_failed");
		return { ok: false, kind, status, reason };
	}
}
