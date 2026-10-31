/** The server's reading of CHAT_DICTATION with and without the deprecated pair: what is offered, and whether /api/transcribe opens. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { value: "" as string, pair: false } }));

vi.mock("$lib/server/config", () => ({
	config: new Proxy(
		{},
		{
			get(_t, key: string) {
				return key === "CHAT_DICTATION" ? state.value : undefined;
			},
		}
	),
}));
vi.mock("./transcription", () => ({ legacyTranscriptionConfigured: () => state.pair }));

import { dictationMode, dictationOffersFor, recorderAllowed } from "./dictation";

beforeEach(() => {
	state.value = "";
	state.pair = false;
});

describe("old values, pair unset: as on main", () => {
	it.each([
		["", true],
		["fallback", true],
		["yes", true],
		["no", false],
	])("%s: browser %s, no recorder", (value, browser) => {
		state.value = value;
		expect(dictationOffersFor(true)).toEqual({ browser, recorder: false });
		expect(recorderAllowed()).toBe(false);
	});
});

describe("old values, pair set: the recorder is always there", () => {
	it.each([
		["", false],
		["fallback", false],
		["yes", true],
		["no", false],
	])("%s: recorder, browser %s", (value, browser) => {
		state.pair = true;
		state.value = value;
		// Even with no gateway model: the pair is what serves it.
		expect(dictationOffersFor(false)).toEqual({ browser, recorder: true });
		expect(recorderAllowed()).toBe(true);
		expect(dictationMode()).toBe("model");
	});
});

describe("new values", () => {
	it("opens /api/transcribe only for model", () => {
		for (const [value, open] of [
			["browser", false],
			["off", false],
			["model", true],
		] as const) {
			state.value = value;
			expect(recorderAllowed()).toBe(open);
		}
	});

	it("an explicit off or browser closes the recorder even with the pair set", () => {
		state.pair = true;
		for (const value of ["off", "browser"]) {
			state.value = value;
			expect(recorderAllowed()).toBe(false);
		}
	});

	it("model needs a usable gateway model unless the pair serves it", () => {
		state.value = "model";
		expect(dictationOffersFor(false).recorder).toBe(false);
		expect(dictationOffersFor(true).recorder).toBe(true);
		state.pair = true;
		expect(dictationOffersFor(false).recorder).toBe(true);
	});
});
