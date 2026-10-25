import { describe, expect, it } from "vitest";
import {
	matchAcceptLanguage,
	parseAcceptLanguage,
	parseLocale,
	resolveLocale,
	selectableLocales,
} from "./resolve";

describe("selectableLocales", () => {
	it("lists real locales only, unless pseudo is allowed", () => {
		expect(selectableLocales(false)).toEqual(["en"]);
		expect(selectableLocales(true)).toEqual(["en", "en-XA"]);
	});
});

describe("parseLocale", () => {
	it("accepts a carried locale, case-insensitively, and nothing else", () => {
		expect(parseLocale("en")).toBe("en");
		expect(parseLocale(" EN ")).toBe("en");
		expect(parseLocale("fr")).toBeUndefined();
		expect(parseLocale(null)).toBeUndefined();
		expect(parseLocale(42)).toBeUndefined();
	});

	it("takes the pseudo-locale only when allowed", () => {
		expect(parseLocale("en-XA")).toBeUndefined();
		expect(parseLocale("en-xa", true)).toBe("en-XA");
	});
});

describe("parseAcceptLanguage", () => {
	it("orders by q, keeps written order for ties, drops q=0 and *", () => {
		expect(parseAcceptLanguage("fr;q=0.5, de, en-GB;q=0.8, it;q=0, *;q=0.1")).toEqual([
			"de",
			"en-GB",
			"fr",
		]);
	});

	it("tolerates empty and malformed input", () => {
		expect(parseAcceptLanguage(null)).toEqual([]);
		expect(parseAcceptLanguage("")).toEqual([]);
		expect(parseAcceptLanguage(",;q=x, ;q=1")).toEqual([]);
	});
});

describe("matchAcceptLanguage", () => {
	it("falls from the full tag to its language, then to the next tag", () => {
		expect(matchAcceptLanguage("en-GB")).toBe("en");
		expect(matchAcceptLanguage("fr-CH, fr;q=0.9, en;q=0.5")).toBe("en");
	});

	it("has no answer for a language we do not carry", () => {
		expect(matchAcceptLanguage("fr, de")).toBeUndefined();
	});

	it("never answers with a pseudo-locale, however it is asked for", () => {
		expect(matchAcceptLanguage("en-XA")).toBe("en");
	});
});

describe("resolveLocale", () => {
	it("prefers the saved choice, then the cookie, then Accept-Language, then English", () => {
		expect(resolveLocale({ saved: "en", cookie: "x", acceptLanguage: "fr" })).toBe("en");
		expect(resolveLocale({ saved: "nope", cookie: "en", acceptLanguage: "fr" })).toBe("en");
		expect(resolveLocale({ cookie: "nope", acceptLanguage: "en-GB" })).toBe("en");
		expect(resolveLocale({ acceptLanguage: "fr" })).toBe("en");
		expect(resolveLocale({})).toBe("en");
	});

	it("honours the pseudo-locale from a saved choice or cookie only when allowed", () => {
		expect(resolveLocale({ saved: "en-XA", pseudo: true })).toBe("en-XA");
		expect(resolveLocale({ cookie: "en-XA", pseudo: true })).toBe("en-XA");
		expect(resolveLocale({ saved: "en-XA", pseudo: false })).toBe("en");
		expect(resolveLocale({ cookie: "en-XA" })).toBe("en");
	});

	it("lets a saved pseudo-locale win over the cookie, and falls back when it is not allowed", () => {
		expect(resolveLocale({ saved: "en-XA", cookie: "en", pseudo: true })).toBe("en-XA");
		expect(resolveLocale({ saved: "en-XA", cookie: "en", pseudo: false })).toBe("en");
	});

	it("never selects the pseudo-locale from Accept-Language", () => {
		expect(resolveLocale({ acceptLanguage: "en-XA", pseudo: true })).toBe("en");
	});
});
