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

/** The recognition language: the browser's, with no setting of its own. */
export function dictationLanguage(): string {
	if (typeof navigator === "undefined") return "en-US";
	return navigator.language || "en-US";
}

/** A short, non-blocking message per recognition error; null when the end of
 * a session needs none (the person or the composer stopped it). */
export function dictationErrorMessage(code: string): string | null {
	switch (code) {
		case "not-allowed":
		case "service-not-allowed":
			return "Microphone access is blocked. Allow it in your browser's site settings to dictate.";
		case "no-speech":
			return "No speech heard. Try again.";
		case "network":
			return "Dictation needs a network connection to your browser's speech service.";
		case "audio-capture":
			return "No microphone found.";
		case "aborted":
			return null;
		default:
			return "Dictation stopped unexpectedly.";
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

/** Everything recognised so far in a session, final and interim alike. */
export function joinTranscript(results: ArrayLike<SpeechRecognitionResultLike>): string {
	let out = "";
	for (let i = 0; i < results.length; i++) {
		const piece = results[i][0].transcript;
		if (out && !/\s$/.test(out) && !/^\s/.test(piece)) out += " ";
		out += piece;
	}
	return out;
}
