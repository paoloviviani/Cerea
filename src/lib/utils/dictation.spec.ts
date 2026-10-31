import { describe, expect, it } from "vitest";
import {
	composeDictation,
	dictationAnchor,
	dictationErrorMessage,
	dictationLanguage,
	dictationOffered,
	dictationOffers,
	parseDictationMode,
	getSpeechRecognition,
	joinTranscript,
	formatRecordingTime,
} from "./dictation";

const result = (transcript: string, isFinal = true) => ({ isFinal, 0: { transcript } });

describe("dictation helpers", () => {
	it("finds no recognition without a window (server render)", () => {
		expect(typeof window).toBe("undefined");
		expect(getSpeechRecognition()).toBeNull();
		expect(dictationLanguage()).toBe("en-US");
	});

	it("inserts at the caret with a space only where one is missing", () => {
		const a = dictationAnchor("hello world", 5, 5);
		expect(composeDictation(a, "big")).toEqual({ value: "hello big world", caret: 9 });
		const b = dictationAnchor("hello ", 6, 6);
		expect(composeDictation(b, "there").value).toBe("hello there");
		const c = dictationAnchor("", 0, 0);
		expect(composeDictation(c, " hi ").value).toBe("hi");
	});

	it("appends at the end and replaces a selection", () => {
		expect(composeDictation(dictationAnchor("abc", 3, 3), "def").value).toBe("abc def");
		expect(composeDictation(dictationAnchor("abc XXX def", 4, 7), "yes").value).toBe("abc yes def");
	});

	it("an empty transcript leaves the typed text alone", () => {
		expect(composeDictation(dictationAnchor("abc", 1, 1), "").value).toBe("abc");
	});

	it("clamps an anchor outside the text", () => {
		expect(dictationAnchor("ab", 9, 12)).toEqual({ before: "ab", after: "" });
	});

	it("joins results, adding a space between them when needed", () => {
		expect(joinTranscript([result("hello"), result("world", false)])).toBe("hello world");
		expect(joinTranscript([result("hello"), result(" world")])).toBe("hello world");
	});

	it("keeps independent desktop segments, one space apart", () => {
		expect(joinTranscript([result("hello there"), result("how are you", false)])).toBe(
			"hello there how are you"
		);
	});

	it("replaces instead of appending when results are cumulative (Android Chrome)", () => {
		expect(
			joinTranscript([result("Hello"), result("hello there"), result("Hello  there friend", false)])
		).toBe("Hello  there friend");
	});

	it("drops a re-delivered final result", () => {
		expect(joinTranscript([result("hello there"), result("Hello  there")])).toBe("hello there");
		expect(
			joinTranscript([result("hello there"), result("how are you"), result("how are you")])
		).toBe("hello there how are you");
	});

	it("maps Safari's service-not-allowed and not-allowed to specific messages", () => {
		expect(dictationErrorMessage("service-not-allowed")).toContain("Siri or Dictation");
		expect(dictationErrorMessage("service-not-allowed")).toContain("Safari");
		expect(dictationErrorMessage("not-allowed")).toContain("microphone permission is blocked");
	});

	it("maps the common errors to short messages", () => {
		for (const code of ["not-allowed", "no-speech", "network", "audio-capture", "other"]) {
			const m = dictationErrorMessage(code);
			expect(m?.length ?? 0).toBeGreaterThan(5);
			expect(m?.length ?? 0).toBeLessThan(200);
		}
		expect(dictationErrorMessage("aborted")).toBeNull();
	});
});

describe("the deployment switch", () => {
	it("reads the three modes, and the old words", () => {
		expect(parseDictationMode("browser")).toBe("browser");
		expect(parseDictationMode(" MODEL ")).toBe("model");
		expect(parseDictationMode("off")).toBe("off");
		expect(parseDictationMode("yes")).toBe("browser");
		expect(parseDictationMode("no")).toBe("off");
		for (const v of [undefined, null, "", "  ", "maybe", "fallback"]) {
			expect(parseDictationMode(v)).toBe("browser");
		}
	});

	it("shows the old words as the model when the legacy pair is set, an explicit choice as itself", () => {
		for (const v of [undefined, "", "yes", "no", "fallback"]) {
			expect(parseDictationMode(v, true)).toBe("model");
		}
		expect(parseDictationMode("off", true)).toBe("off");
		expect(parseDictationMode("browser", true)).toBe("browser");
	});

	// [stored value, legacy pair, browser button, recorder] — what main did before the
	// three-way choice: the pair always put the recorder in chat, and `yes` was the
	// only value that kept the browser button beside it.
	const OLD: [string | undefined, boolean, boolean, boolean][] = [
		[undefined, false, true, false],
		["fallback", false, true, false],
		["yes", false, true, false],
		["no", false, false, false],
		[undefined, true, false, true],
		["fallback", true, false, true],
		["yes", true, true, true],
		["no", true, false, true],
	];
	for (const [value, pair, browser, recorder] of OLD) {
		it(`old value ${value ?? "unset"}, pair ${pair ? "set" : "unset"}: browser ${browser}, recorder ${recorder}`, () => {
			expect(dictationOffers(value, pair, true)).toEqual({ browser, recorder });
		});
	}

	it("makes the new values exact, with or without the pair", () => {
		for (const pair of [false, true]) {
			expect(dictationOffers("browser", pair, true)).toEqual({ browser: true, recorder: false });
			expect(dictationOffers("model", pair, true)).toEqual({ browser: false, recorder: true });
			expect(dictationOffers("off", pair, true)).toEqual({ browser: false, recorder: false });
		}
	});

	it("needs a usable model for the recorder through the gateway, not for the legacy pair", () => {
		expect(dictationOffers("model", false, false).recorder).toBe(false);
		expect(dictationOffers("model", true, false).recorder).toBe(true);
	});

	it("offers the browser button only where the browser can", () => {
		expect(dictationOffered(true, true)).toBe(true);
		expect(dictationOffered(true, false)).toBe(false);
		expect(dictationOffered(false, true)).toBe(false);
	});

	it("formats the recording timer", () => {
		expect(formatRecordingTime(0)).toBe("0:00");
		expect(formatRecordingTime(7.9)).toBe("0:07");
		expect(formatRecordingTime(125)).toBe("2:05");
	});
});
