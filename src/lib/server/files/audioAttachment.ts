/**
 * Audio attachments: what counts as one, and how the model is told about its
 * transcript. The transcript is made once at upload (`uploadFile.ts`,
 * `$lib/server/transcription`) and stored beside the file as extracted text;
 * the turn gets it labelled, or a sentence saying why there is none.
 */
import type { MessageFile } from "$lib/types/Message";

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
};

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
	const direct = SNIFFED_AUDIO[sniffed];
	if (direct) return direct;
	const container = CONTAINERS[sniffed];
	if (container && !hasVideoTrack(sniffed, bytes)) return container;
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
