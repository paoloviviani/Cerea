/**
 * Audio attachments: what counts as one, and how the model is told about its
 * transcript. The transcript is made once at upload (`uploadFile.ts`,
 * `$lib/server/transcription`) and stored beside the file as extracted text;
 * the turn gets it labelled, or a sentence saying why there is none.
 */
import type { MessageFile } from "$lib/types/Message";
import { mimeEssence } from "$lib/utils/mimeMatch";

/**
 * What the bytes sniff as, mapped to the one type stored and sent on: only
 * these, never what the browser said. (`file-type` names the same audio
 * several ways.)
 */
const SNIFFED_AUDIO: Record<string, string> = {
	"audio/mpeg": "audio/mpeg",
	"audio/mp4": "audio/mp4",
	"audio/x-m4a": "audio/mp4",
	"audio/m4a": "audio/mp4",
	"audio/wav": "audio/wav",
	"audio/vnd.wave": "audio/wav",
	"audio/x-wav": "audio/wav",
	"audio/ogg": "audio/ogg",
	"audio/opus": "audio/ogg",
	"audio/flac": "audio/flac",
	"audio/x-flac": "audio/flac",
	"audio/webm": "audio/webm",
};

/** Containers that hold sound or picture; audio only when no video track is in them. */
const CONTAINERS: Record<string, string> = {
	"video/mp4": "audio/mp4",
	"video/webm": "audio/webm",
	// Phone recorders write audio-only 3GPP/QuickTime/M4V files, which
	// `file-type` names by brand as video.
	"video/3gpp": "audio/mp4",
	"video/3gpp2": "audio/mp4",
	"video/quicktime": "audio/mp4",
	"video/x-m4v": "audio/mp4",
};

/** Other names for the same audio a client may declare (dictation trusts it: the bytes are not sniffed). */
const DECLARED_ALIASES: Record<string, string> = {
	"audio/mp3": "audio/mpeg",
	"audio/wave": "audio/wav",
	"audio/mp4a-latm": "audio/mp4",
	"audio/x-mp4a-latm": "audio/mp4",
	"audio/3gpp": "audio/mp4",
	"audio/3gpp2": "audio/mp4",
	"audio/x-opus+ogg": "audio/ogg",
	"audio/x-ogg": "audio/ogg",
};

/**
 * The audio type a declared `Content-Type` stands for (parameters ignored,
 * aliases folded), with the extension to name it by; null when it is not one
 * we transcribe.
 */
export function declaredAudio(contentType: string): { mime: string; extension: string } | null {
	const type = mimeEssence(contentType);
	const mime = SNIFFED_AUDIO[type] ?? DECLARED_ALIASES[type];
	return mime ? { mime, extension: EXTENSION[mime] } : null;
}

/** The extension a transcription server keys off, per type sent. */
const EXTENSION: Record<string, string> = {
	"audio/mpeg": "mp3",
	"audio/mp4": "m4a",
	"audio/wav": "wav",
	"audio/ogg": "ogg",
	"audio/flac": "flac",
	"audio/webm": "webm",
};

/**
 * The file name sent to the transcription model: the user's name with the
 * extension of the type the bytes proved to be. Whisper-compatible servers
 * pick the decoder from the extension, and a recorder's own (`.opus`, `.3gp`,
 * `.amr`, none) is not always one they know.
 */
export function transcriptionFilename(name: string, mime: string): string {
	const ext = EXTENSION[mime];
	if (!ext) return name;
	const base = name.replace(/^.*[\\/]/, "").replace(/\.[^./\\]*$/, "") || "audio";
	return `${base}.${ext}`;
}

/** What may be attached, in words, for a refusal. */
export const SUPPORTED_AUDIO_TEXT = "MP3, M4A (MP4 audio), WAV, OGG/Opus, FLAC and WebM";

/**
 * Why audio the bytes name is not taken, or null when the file does not look
 * like audio at all (the caller's generic message then stands).
 */
export function unsupportedAudioMessage(
	sniffed: string | undefined,
	name: string,
	declared: string,
	bytes: Uint8Array
): string | null {
	const type = mimeEssence(sniffed ?? "");
	if (type === "audio/aac") {
		return "AAC files (.aac) aren't supported for transcription. Export the recording as M4A or MP3 and attach that.";
	}
	if (CONTAINERS[type] && hasVideoTrack(type, bytes)) {
		return `This file has a video track, so it isn't transcribed. Attach audio only: ${SUPPORTED_AUDIO_TEXT}.`;
	}
	const declaredAudio = mimeEssence(declared).startsWith("audio/");
	const namedAudio = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba|3gp|3gpp|amr|wma|aiff?)$/i.test(
		name
	);
	if (type.startsWith("audio/") || declaredAudio || (namedAudio && !sniffed)) {
		return `This audio format isn't supported for transcription. Supported: ${SUPPORTED_AUDIO_TEXT}.`;
	}
	return null;
}

/** Whether `needle` occurs in `bytes` (ASCII). */
function contains(bytes: Uint8Array, needle: string): boolean {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(
		needle,
		0,
		"latin1"
	);
}

/**
 * Whether a container has a video track, as far as it can be told cheaply:
 * an MP4/MOV declares each track's kind in an `hdlr` box ("vide" or "soun"),
 * a WebM/Matroska file names each track's codec ("V_VP9", "A_OPUS"). Either
 * marker found means video.
 */
function hasVideoTrack(sniffed: string, bytes: Uint8Array): boolean {
	if (sniffed === "video/webm") return contains(bytes, "V_");
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (
		let at = buffer.indexOf("hdlr", 0, "latin1");
		at !== -1;
		at = buffer.indexOf("hdlr", at + 4, "latin1")
	) {
		// hdlr: version/flags (4), pre_defined (4), then the handler type.
		if (buffer.toString("latin1", at + 12, at + 16) === "vide") return true;
	}
	return false;
}

/**
 * The audio type to treat an upload as, or null when it is not audio.
 *
 * Decided by the bytes alone, never the browser's `file.type` or the name: a
 * spoofed type cannot send a file to a transcription model. Anything `file-type`
 * sniffs as an allowed audio format is audio; an MP4 or WebM container is audio
 * only when its tracks say there is no video in it. A file we cannot tell (no
 * signature, an unrecognised container) stays a plain file.
 */
export function audioMime(sniffed: string | undefined, bytes: Uint8Array): string | null {
	if (!sniffed) return null;
	// `file-type` names Opus-in-Ogg `audio/ogg; codecs=opus`: compare the type alone.
	const type = mimeEssence(sniffed);
	const direct = SNIFFED_AUDIO[type];
	if (direct) return direct;
	const container = CONTAINERS[type];
	if (container && !hasVideoTrack(type, bytes)) return container;
	return null;
}

export function isAudioFile(file: Pick<MessageFile, "mime">): boolean {
	return file.mime.startsWith("audio/");
}

/** `3:25` or `1:02:07`. */
export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The transcript as the model reads it: named, with what is known about the recording. */
export function labelledTranscript(
	name: string,
	text: string,
	audio: MessageFile["audio"] | undefined
): string {
	const facts = [
		audio?.durationSeconds ? `duration ${formatDuration(audio.durationSeconds)}` : null,
		audio?.language ? `language ${audio.language}` : null,
	].filter(Boolean);
	const suffix = facts.length ? ` (${facts.join(", ")})` : "";
	return `Transcript of the audio file "${name}"${suffix}, made automatically from the recording:\n\n${text}`;
}

const MAX_REASON_CHARS = 500;

/** In place of a transcript there is none: say why, so the model can tell the user. */
export function missingTranscriptNotice(
	name: string,
	error: MessageFile["extractionError"]
): string {
	const say = "Say so rather than guessing at what was said.";
	const head = `The audio file "${name}" is attached but has no transcript.`;
	if (!error) return `${head} The reason was not recorded. ${say}`;
	const reason = error.reason.trim().slice(0, MAX_REASON_CHARS);
	return `${head} ${reason} ${say}`;
}
