import { describe, expect, it, vi } from "vitest";
vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const { preConsentCookies } = await import("./consent");

describe("preConsentCookies", () => {
	it.each([
		["https://www.google.com/search?q=x", ".google.com"],
		["https://www.google.it/", ".google.it"],
		["https://news.google.co.uk/", ".google.co.uk"],
		["https://www.youtube.com/watch?v=1", ".youtube.com"],
	])("sets the reject cookie for %s", (url, domain) => {
		const cookies = preConsentCookies(url);
		expect(cookies).toHaveLength(1);
		expect(cookies[0]).toMatchObject({
			name: "SOCS",
			value: "CAE=",
			domain,
			path: "/",
			secure: true,
		});
	});

	it("expires in the future", () => {
		const now = Date.UTC(2026, 10, 1);
		expect(preConsentCookies("https://www.google.com/", now)[0].expires).toBeGreaterThan(
			now / 1000
		);
	});

	it.each([
		"https://example.test/",
		"https://notgoogle.com/",
		"https://google.com.evil.test/",
		"nope",
	])("sets nothing for %s", (url) => expect(preConsentCookies(url)).toEqual([]));
});
