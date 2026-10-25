import { describe, expect, it } from "vitest";
import { LOCALE_COOKIE, localeFromCookieHeader, localeLabel } from "./locale";

describe("localeFromCookieHeader", () => {
	it("reads the choice cookie among others", () => {
		expect(localeFromCookieHeader(`a=1; ${LOCALE_COOKIE}=en; b=2`)).toBe("en");
	});

	it("ignores an unknown locale, a missing cookie and a malformed value", () => {
		expect(localeFromCookieHeader(`${LOCALE_COOKIE}=klingon`)).toBeUndefined();
		expect(localeFromCookieHeader("a=1")).toBeUndefined();
		expect(localeFromCookieHeader(`${LOCALE_COOKIE}=%E0%A4%A`)).toBeUndefined();
		expect(localeFromCookieHeader(null)).toBeUndefined();
	});

	it("takes the pseudo-locale only when allowed", () => {
		expect(localeFromCookieHeader(`${LOCALE_COOKIE}=en-XA`)).toBeUndefined();
		expect(localeFromCookieHeader(`${LOCALE_COOKIE}=en-XA`, true)).toBe("en-XA");
	});
});

describe("localeLabel", () => {
	it("names a language in itself, capitalised", () => {
		expect(localeLabel("en")).toBe("English");
	});
});
