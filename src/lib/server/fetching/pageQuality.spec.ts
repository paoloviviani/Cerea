import { describe, expect, it } from "vitest";
import {
	consentScore,
	detectGate,
	isConsentRedirectHost,
	looksLikeRealPage,
	MIN_REAL_PAGE_CHARS,
} from "./pageQuality";

const prose = (n: number) =>
	"The council met on Tuesday to discuss the new bridge, its cost and the schedule for works. ".repeat(
		Math.ceil(n / 90)
	);

const BANNER_EN =
	"We and our partners use cookies and similar technologies to personalise ads and measure tracking. " +
	"Accept all or reject all, or manage your preferences. See our privacy policy and consent settings.";

describe("isConsentRedirectHost", () => {
	it.each([
		["https://consent.google.com/ml?continue=x", true],
		["https://consent.yahoo.com/v2/collectConsent", true],
		["https://guce.yahoo.com/consent", true],
		["https://www.google.com/search?q=x", false],
		["https://example.test/consent", false],
		["not a url", false],
	])("%s", (url, expected) => expect(isConsentRedirectHost(url)).toBe(expected));
});

describe("detectGate", () => {
	it("recognises a consent banner in English", () => expect(detectGate(BANNER_EN)).toBe("consent"));
	it("recognises one in Italian", () =>
		expect(
			detectGate(
				"Utilizziamo cookie e consenso per il trattamento dei dati personali. Accetta tutto oppure rifiuta tutto. " +
					"I nostri partner usano cookie per la pubblicita."
			)
		).toBe("consent"));
	it("recognises one in German", () =>
		expect(
			detectGate(
				"Wir und unsere Partner verwenden Cookies. Ihre Einwilligung: alle akzeptieren oder alle ablehnen. " +
					"Datenschutz und Cookies, Cookies, Cookies."
			)
		).toBe("consent"));
	it("recognises a consent redirect host whatever the text", () =>
		expect(detectGate(prose(2000), "https://consent.yahoo.com/x")).toBe("consent"));
	it("recognises a pay-or-accept wall", () => {
		expect(
			detectGate("Pay or accept: read on with tracking, or subscribe to read without ads.")
		).toBe("paywall");
		expect(detectGate("Mit Werbung und Tracking weiterlesen oder Pur-Abo abschliessen.")).toBe(
			"paywall"
		);
	});
	it("leaves an ordinary article alone", () => expect(detectGate(prose(3000))).toBeNull());
	it("leaves a long article that discusses cookies alone", () => {
		const text = prose(6000) + " Cookies and tracking, a partner said, and consent matters.";
		expect(detectGate(text)).toBeNull();
	});
	it("does not take one mention of cookies for a wall", () =>
		expect(detectGate("A short recipe for chocolate cookies with butter and sugar.")).toBeNull());
});

describe("consentScore", () => {
	it("counts distinct terms and occurrences", () => {
		const s = consentScore("cookies cookies consent");
		expect(s.distinct).toBe(2);
		expect(s.total).toBe(3);
	});
});

describe("looksLikeRealPage", () => {
	const url = "https://example.test/a";
	it("accepts substantial prose", () =>
		expect(looksLikeRealPage(prose(MIN_REAL_PAGE_CHARS + 100), url)).toBe(true));
	it("rejects text under the minimum", () =>
		expect(looksLikeRealPage(prose(300), url)).toBe(false));
	it("rejects a consent notice even when long enough", () =>
		expect(looksLikeRealPage(BANNER_EN.repeat(4), url)).toBe(false));
	it("rejects a known consent redirect host", () =>
		expect(looksLikeRealPage(prose(2000), "https://consent.google.com/m")).toBe(false));
	it("rejects an empty JavaScript shell", () => {
		const shell =
			"Please enable JavaScript to run this app. ".repeat(20) + "Loading the application now.";
		expect(looksLikeRealPage(shell, url)).toBe(false);
	});
	it("rejects a near-empty body behind a noscript notice", () => {
		const html = `<html><head><script>${"x".repeat(60_000)}</script></head><body><noscript>Turn it on</noscript>${"<div></div>".repeat(10)}</body></html>`;
		expect(looksLikeRealPage(prose(MIN_REAL_PAGE_CHARS + 50), url, html)).toBe(false);
	});
	it("accepts a text-rich page that also carries a noscript tag", () => {
		const text = prose(5000);
		expect(looksLikeRealPage(text, url, `<noscript>x</noscript><p>${text}</p>`)).toBe(true);
	});
	it("accepts a homepage made of headlines", () => {
		const headlines = Array.from(
			{ length: 60 },
			(_, i) => `Headline number ${i}: the government announces a plan`
		).join(" ");
		expect(looksLikeRealPage(headlines, url)).toBe(true);
	});
});
