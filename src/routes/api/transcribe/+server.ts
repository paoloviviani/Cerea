import {
	legacyTranscriptionConfigured,
	transcribeAudio,
	transcriptionBaseUrl,
	TRANSCRIPTION_MAX_BYTES,
	TRANSCRIPTION_CAP_MINUTES,
	warnLegacyTranscription,
} from "$lib/server/transcription";
import { dictationMode } from "$lib/server/dictation";
import { error, json } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { getApiToken } from "$lib/server/apiToken";
import { billToHeader } from "$lib/server/billTo";
import { logger } from "$lib/server/logger";

const MAX_AUDIO_SIZE = TRANSCRIPTION_MAX_BYTES; // the gateway's own cap
const TOO_LONG = `This recording is too long to transcribe (up to about ${TRANSCRIPTION_CAP_MINUTES} minutes). Record a shorter one.`;
const TRANSCRIPTION_TIMEOUT = 60000; // 60 seconds

const ALLOWED_CONTENT_TYPES = [
	"audio/webm",
	"audio/ogg",
	"audio/wav",
	"audio/flac",
	"audio/mpeg",
	"audio/mp4",
	"audio/x-wav",
];

/**
 * Dictation by a transcription model: the composer sends one recording, this
 * sends it on as the signed-in user, through the gateway's
 * `/v1/audio/transcriptions` (metered with their token, their groups, their
 * bill-to). Only when the administrator chose "Transcription model" under
 * Administration -> Voice.
 *
 * The deprecated `TRANSCRIPTION_BASE_URL` + `TRANSCRIPTION_MODEL` pair, when
 * set, still takes precedence and goes direct (one deprecation line is logged).
 */
export async function POST({ request, locals }) {
	if (dictationMode() !== "model") {
		throw error(403, "Dictation by a transcription model is not turned on.");
	}
	// Through the gateway it is always the user's own token (metering, groups,
	// bill-to); the deprecated direct endpoint keeps the credential it always had.
	const token = legacyTranscriptionConfigured() ? getApiToken(locals) : locals.token;

	if (!token) {
		throw error(401, "Authentication required");
	}

	const rawContentType = request.headers.get("content-type") || "";
	// Normalize content-type: Safari sends "audio/webm; codecs=opus" (with space)
	// but HF API expects "audio/webm;codecs=opus" (no space)
	const contentType = rawContentType.replace(/;\s+/g, ";");
	const isAllowed = ALLOWED_CONTENT_TYPES.some((type) => contentType.includes(type));

	if (!isAllowed) {
		logger.warn({ contentType }, "Unsupported audio format for transcription");
		throw error(400, `Unsupported audio format: ${contentType}`);
	}

	const contentLength = parseInt(request.headers.get("content-length") || "0");
	if (contentLength > MAX_AUDIO_SIZE) {
		throw error(413, TOO_LONG);
	}

	if (!legacyTranscriptionConfigured()) {
		const audioBuffer = await request.arrayBuffer();
		if (audioBuffer.byteLength > MAX_AUDIO_SIZE) throw error(413, TOO_LONG);
		const extension = contentType.match(/audio\/(?:x-)?([a-z0-9]+)/)?.[1] ?? "webm";
		const heard = await transcribeAudio({
			bytes: audioBuffer,
			mime: contentType.split(";")[0],
			filename: `dictation.${extension}`,
			token,
			billHeaders: billToHeader(locals?.billingOrganization),
		});
		if (!heard.ok) throw error(heard.status === 401 ? 401 : heard.status, heard.reason);
		return json({ text: heard.text });
	}

	warnLegacyTranscription();
	const transcriptionModel = config.get("TRANSCRIPTION_MODEL");
	const baseUrl = transcriptionBaseUrl() as string;

	try {
		const audioBuffer = await request.arrayBuffer();

		if (audioBuffer.byteLength > MAX_AUDIO_SIZE) {
			throw error(413, TOO_LONG);
		}

		const apiUrl = `${baseUrl}/${transcriptionModel}`;

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT);

		const response = await fetch(apiUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": contentType,
				// Which group pays, when the person chose one (ADR 0061).
				...billToHeader(locals?.billingOrganization),
			},
			body: audioBuffer,
			signal: controller.signal,
		}).finally(() => clearTimeout(timeoutId));

		if (!response.ok) {
			const errorText = await response.text();
			logger.error(
				{ status: response.status, error: errorText, model: transcriptionModel },
				"Whisper API error"
			);
			throw error(response.status, `Transcription failed: ${errorText}`);
		}

		const result = await response.json();

		// Whisper API returns { text: "transcribed text" }
		// Filter out responses that only contain dots (e.g. "..." returned for silence/unclear audio)
		const text = (result.text || "").trim();
		const isOnlyDots = /^\.+$/.test(text);
		return json({ text: isOnlyDots ? "" : text });
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			logger.error({ model: transcriptionModel }, "Transcription timeout");
			throw error(504, "Transcription took too long. Please try a shorter recording.");
		}

		// Re-throw SvelteKit errors
		if (err && typeof err === "object" && "status" in err) {
			throw err;
		}

		logger.error(err, "Transcription error");
		throw error(500, "Failed to transcribe audio");
	}
}
