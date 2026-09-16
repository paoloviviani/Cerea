import { describe, expect, it, vi } from "vitest";
import {
	DUCKDUCKGO_ENDPOINT,
	isDuckDuckGoChallenge,
	parseDuckDuckGoResults,
	searchDuckDuckGo,
} from "./duckDuckGoSearch";

const PAGE = `
<div class="result results_links results_links_deep web-result">
<div class="links_main links_deep result__body">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample%2Eorg%2F1&amp;rut=abc123">First <b>Result</b></a>
</h2>
<div class="result__extras"><div class="result__extras__url">example.org</div>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample%2Eorg%2F1">One &amp; only.</a>
</div></div></div>
<div class="result results_links results_links_deep web-result">
<div class="links_main links_deep result__body">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="https://example.org/2">Second</a>
</h2>
</div></div></div>
<div class="result results_links results_links_deep web-result">
<div class="links_main links_deep result__body">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="http://insecure.example/3">Insecure</a>
</h2>
</div></div></div>
`;

const CHALLENGE = `<form id="challenge-form"><div class="anomaly-modal__mask">
<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></div></form>`;

describe("parseDuckDuckGoResults", () => {
	it("unwraps redirect links, strips markup and decodes entities", () => {
		expect(parseDuckDuckGoResults(PAGE, 10)).toEqual([
			{ title: "First Result", url: "https://example.org/1", snippet: "One & only." },
			{ title: "Second", url: "https://example.org/2", snippet: "" },
		]);
	});

	it("drops non-HTTPS targets and caps the count", () => {
		const hits = parseDuckDuckGoResults(PAGE, 1);
		expect(hits).toHaveLength(1);
		expect(hits[0].url).toBe("https://example.org/1");
	});

	it("names untitled results and tolerates an unparseable page", () => {
		const hits = parseDuckDuckGoResults(
			`<a class="result__a" href="https://example.org/x"></a>`,
			5
		);
		expect(hits).toEqual([{ title: "untitled", url: "https://example.org/x", snippet: "" }]);
		expect(parseDuckDuckGoResults("<html><body>no results here</body></html>", 5)).toEqual([]);
	});
});

describe("isDuckDuckGoChallenge", () => {
	it("recognises the bot challenge", () => {
		expect(isDuckDuckGoChallenge(CHALLENGE)).toBe(true);
		expect(isDuckDuckGoChallenge(PAGE)).toBe(false);
	});
});

describe("searchDuckDuckGo", () => {
	it("POSTs the query as a form and parses the answer", async () => {
		const fetchMock = vi.fn(async () => new Response(PAGE, { status: 200 }));
		const outcome = await searchDuckDuckGo("european cloud providers", 5, fetchMock as never);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(DUCKDUCKGO_ENDPOINT);
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			"content-type": "application/x-www-form-urlencoded",
		});
		expect(String(init.body)).toContain("q=european+cloud+providers");
		expect(init.signal).toBeInstanceOf(AbortSignal);

		expect(outcome).toEqual({
			blocked: false,
			hits: [
				{ title: "First Result", url: "https://example.org/1", snippet: "One & only." },
				{ title: "Second", url: "https://example.org/2", snippet: "" },
			],
		});
	});

	it("reports the bot challenge as blocked rather than throwing", async () => {
		const fetchMock = vi.fn(async () => new Response(CHALLENGE, { status: 200 }));
		await expect(searchDuckDuckGo("anything", 5, fetchMock as never)).resolves.toEqual({
			blocked: true,
			hits: [],
		});
	});

	it("throws on a non-2xx answer", async () => {
		const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
		await expect(searchDuckDuckGo("anything", 5, fetchMock as never)).rejects.toThrow(
			"DuckDuckGo answered 503."
		);
	});
});
