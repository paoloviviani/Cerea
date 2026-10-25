import { m } from "$lib/paraglide/messages";
/**
 * Dictation into the composer with the browser's own speech recognition
 * (`SpeechRecognition`, `webkitSpeechRecognition` in Chrome and Safari). No
 * speech model ships with the stack; some browsers send the audio to the
 * vendor's cloud for recognition (docs/chat.md says so).
 */

/** The slice of the Web Speech API the composer uses. */
export interface SpeechRecognitionResultLike {
	readonly isFinal: boolean;
	readonly 0: { readonly transcript: string };
}

export interface SpeechRecognitionEventLike {
	readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionLike {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	onresult: ((event: SpeechRecognitionEventLike) => void) | null;
	onerror: ((event: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** The constructor, or null on the server and in browsers without
 * recognition (Firefox). Evaluated per call, never at module scope, so the
 * server render never touches `window`. */
export function getSpeechRecognition(): SpeechRecognitionCtor | null {
	if (typeof window === "undefined") return null;
	const w = window as unknown as {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	};
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Safari and other WebKit browsers: only the prefixed constructor exists.
 * Their recognition refuses with `not-allowed` without ever showing the
 * microphone prompt, so the composer asks for the microphone itself first. */
export function needsMicrophonePrompt(): boolean {
	if (typeof window === "undefined") return false;
	const w = window as unknown as {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	};
	return !w.SpeechRecognition && !!w.webkitSpeechRecognition;
}

/** The recognition language: the browser's, with no setting of its own. */
export function dictationLanguage(): string {
	if (typeof navigator === "undefined") return "en-US";
	return navigator.language || "en-US";
}

/** Shown when a session ends by itself without a result or an error (Safari
 * can do that). */
/** A function, so the words follow the language in use when they are shown. */
export const dictationSilentEndMessage = (): string => m["chat.dictation.silent_end"]();

/** A short, non-blocking message per recognition error; null when the end of
 * a session needs none (the person or the composer stopped it). */
export function dictationErrorMessage(code: string): string | null {
	switch (code) {
		case "service-not-allowed":
			return m["chat.dictation.service_not_allowed"]();
		case "not-allowed":
			return m["chat.dictation.not_allowed"]();
		case "no-speech":
			return m["chat.dictation.no_speech"]();
		case "network":
			return m["chat.dictation.network"]();
		case "audio-capture":
			return m["chat.dictation.no_microphone"]();
		case "aborted":
			return null;
		default:
			return m["chat.dictation.unexpected"]();
	}
}

/** Where dictated text goes: around what the person had already typed. */
export interface DictationAnchor {
	before: string;
	after: string;
}

export function dictationAnchor(value: string, start: number, end: number): DictationAnchor {
	const s = Math.max(0, Math.min(start, value.length));
	const e = Math.max(s, Math.min(end, value.length));
	return { before: value.slice(0, s), after: value.slice(e) };
}

/** The draft with `transcript` inserted at the anchor, a space on each side
 * only where the neighbouring text does not already supply one. Rebuilt from
 * the anchor on every recognition event, so interim text is replaced, never
 * accumulated. `caret` is the position just after the dictated text. */
export function composeDictation(
	anchor: DictationAnchor,
	transcript: string
): { value: string; caret: number } {
	const text = transcript.trim();
	if (!text) return { value: anchor.before + anchor.after, caret: anchor.before.length };
	const lead = anchor.before && !/\s$/.test(anchor.before) ? " " : "";
	const trail = anchor.after && !/^\s/.test(anchor.after) ? " " : "";
	const head = anchor.before + lead + text;
	return { value: head + trail + anchor.after, caret: head.length };
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Everything recognised so far in a session, final and interim alike.
 * Desktop browsers deliver independent segments, joined with one space.
 * Chrome on Android delivers cumulative results (each transcript repeats the
 * earlier ones) and may re-deliver a final one: a result that starts with the
 * text so far replaces it, and one identical to the previous result is
 * dropped. */
export function joinTranscript(results: ArrayLike<SpeechRecognitionResultLike>): string {
	let out = "";
	let previous = "";
	for (let i = 0; i < results.length; i++) {
		const piece = results[i][0].transcript;
		const norm = normalise(piece);
		if (!norm || norm === previous) continue;
		previous = norm;
		const sofar = normalise(out);
		if (sofar && norm.startsWith(sofar)) {
			out = piece;
			continue;
		}
		if (out && !/\s$/.test(out) && !/^\s/.test(piece)) out += " ";
		out += piece;
	}
	return out;
}

/** The deployment-wide switch (Administration -> Voice). */
export const DICTATION_MODES = ["yes", "no", "fallback"] as const;
export type DictationMode = (typeof DICTATION_MODES)[number];

/** A stored or env value, read leniently; anything unknown is the default. */
export function parseDictationMode(value: string | undefined | null): DictationMode {
	const raw = (value ?? "").trim().toLowerCase();
	return (DICTATION_MODES as readonly string[]).includes(raw) ? (raw as DictationMode) : "fallback";
}

/** Whether the composer shows the dictation button: the deployment allows it,
 * the browser can do it, and (in `fallback`) no server-side recorder is
 * already there. */
export function dictationOffered(
	mode: DictationMode,
	browserSupported: boolean,
	serverTranscription: boolean
): boolean {
	if (!browserSupported || mode === "no") return false;
	return mode === "yes" || !serverTranscription;
}
