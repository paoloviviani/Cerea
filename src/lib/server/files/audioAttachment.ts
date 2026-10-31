/**
 * Audio attachments: what counts as one, and how the model is told about its
 * transcript. The transcript is made once at upload (`uploadFile.ts`,
 * `$lib/server/transcription`) and stored beside the file as extracted text;
 * the turn gets it labelled, or a sentence saying why there is none.
 */
import type { MessageFile } from "$lib/types/Message";

/** What `file-type` calls a container that may hold only sound. */
const AMBIGUOUS_CONTAINERS = new Set([
	"video/mp4",
	"video/webm",
	"video/ogg",
	"application/ogg",
	"video/x-m4v",
]);

const EXTENSION_MIME: Record<string, string> = {
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	mp4: "audio/mp4",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	webm: "audio/webm",
	flac: "audio/flac",
};

/**
 * The audio type to treat an upload as, or null when it is not audio.
 *
 * The bytes decide first: anything `file-type` sniffs as `audio/*`. An mp4,
 * webm or ogg container (which it calls `video/*`) is audio only when the
 * browser said `audio/*` or the name is an audio extension; a `.mp4` with
 * video in it, declared `video/mp4`, is not sent to a transcription model.
 */
export function audioMime(sniffed: string, declared: string, filename: string): string | null {
	if (sniffed.startsWith("audio/")) return sniffed;
	if (!AMBIGUOUS_CONTAINERS.has(sniffed)) return null;
	const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
	if (declared.startsWith("audio/")) return declared;
	// `video/*` declared with a plain `.mp4` name is a video.
	if (declared.startsWith("video/") && ext === "mp4") return null;
	return EXTENSION_MIME[ext] && ext !== "mp4" ? EXTENSION_MIME[ext] : null;
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
