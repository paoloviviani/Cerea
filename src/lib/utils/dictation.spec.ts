import { describe, expect, it } from "vitest";
import {
	composeDictation,
	dictationAnchor,
	dictationErrorMessage,
	dictationLanguage,
	dictationOffered,
	parseDictationMode,
	getSpeechRecognition,
	joinTranscript,
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

	it("maps the common errors to short messages", () => {
		for (const code of ["not-allowed", "no-speech", "network", "audio-capture", "other"]) {
			const m = dictationErrorMessage(code);
			expect(m?.length ?? 0).toBeGreaterThan(5);
			expect(m?.length ?? 0).toBeLessThan(100);
		}
		expect(dictationErrorMessage("aborted")).toBeNull();
	});
});

describe("the deployment switch", () => {
	it("defaults to fallback for anything unset or unknown", () => {
		for (const v of [undefined, null, "", "  ", "maybe"]) {
			expect(parseDictationMode(v)).toBe("fallback");
		}
		expect(parseDictationMode(" YES ")).toBe("yes");
		expect(parseDictationMode("no")).toBe("no");
	});

	it("offers the button per mode, browser support and server transcription", () => {
		// [mode, browser supports, server transcription] -> shown
		const table: [Parameters<typeof dictationOffered>[0], boolean, boolean, boolean][] = [
			["yes", true, false, true],
			["yes", true, true, true],
			["no", true, false, false],
			["no", true, true, false],
			["fallback", true, false, true],
			["fallback", true, true, false],
			["yes", false, false, false],
			["fallback", false, false, false],
		];
		for (const [mode, supported, transcription, shown] of table) {
			expect(dictationOffered(mode, supported, transcription)).toBe(shown);
		}
	});
});
