import { beforeEach, describe, expect, it, vi } from "vitest";

const { config, contentFetch, renderWithPlaywright, isValidUrl } = vi.hoisted(() => ({
	config: { FETCH_BACKEND: "direct" } as Record<string, string>,
	contentFetch: vi.fn(),
	renderWithPlaywright: vi.fn(),
	isValidUrl: vi.fn((u: string) => u.startsWith("https://")),
}));
vi.mock("$lib/server/config", () => ({ config }));
vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/server/urlSafety", () => ({ contentFetch, isValidUrl }));
vi.mock("$lib/server/files/extractDocument", () => ({
	documentMime: (m: string) => m,
	isExtractableDocument: (m: string) => m === "application/pdf",
}));
vi.mock("./playwright", () => ({ renderWithPlaywright }));

const { fetchPage } = await import("./index");
const { parseFeed, discoverFeeds, MAX_FEED_ITEMS } = await import("./feed");
const { toggleTrailingSlash, statusFailureMessage } = await import("./status");

function feedOf(xml: string) {
	const feed = parseFeed(xml);
	if (!feed) throw new Error("not a feed");
	return feed;
}

/** Answers by URL: a status, or a 200 with a body and type. */
function site(routes: Record<string, number | { body: string; type: string }>) {
	contentFetch.mockImplementation(async (url: string) => {
		const route = routes[url];
		if (route === undefined) return new Response("", { status: 404 });
		if (typeof route === "number") return new Response("", { status: route });
		const response = new Response(route.body, { headers: { "content-type": route.type } });
		Object.defineProperty(response, "url", { value: url });
		return response;
	});
}

const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>Il Post &amp; co</title><link>https://www.ilpost.it/</link>
<item><title><![CDATA[First &amp; best]]></title><link>https://www.ilpost.it/a/</link><pubDate>Mon, 02 Nov 2026 10:00:00 +0000</pubDate>
<description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt; &amp;amp; more&lt;/p&gt;</description></item>
<item><title>Second</title><link>https://www.ilpost.it/b/</link></item>
</channel></rss>`;
const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><link href="https://b.test/" rel="alternate"/><link href="https://b.test/feed" rel="self"/>
<entry><title>Post</title><link href="https://b.test/p1"/><updated>2026-11-01T08:00:00Z</updated><summary>Short &lt;i&gt;text&lt;/i&gt;</summary></entry></feed>`;
const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Old</title><link>https://o.test/</link></channel>
<item><title>Item</title><link>https://o.test/1</link><dc:date>2026-10-01</dc:date><description>Desc</description></item></rdf:RDF>`;

describe("toggleTrailingSlash", () => {
	it("toggles both ways, keeps query and fragment, never on the bare origin", () => {
		expect(toggleTrailingSlash("https://a.test/feed/")).toBe("https://a.test/feed");
		expect(toggleTrailingSlash("https://a.test/feed?x=1#f")).toBe("https://a.test/feed/?x=1#f");
		expect(toggleTrailingSlash("https://a.test/")).toBeNull();
		expect(toggleTrailingSlash("https://a.test")).toBeNull();
		expect(toggleTrailingSlash("https://a.test/feed.xml")).toBeNull();
	});
});

describe("slash retry", () => {
	beforeEach(() => {
		contentFetch.mockReset();
		renderWithPlaywright.mockReset();
		isValidUrl.mockClear();
		config.FETCH_BACKEND = "direct";
	});

	it.each([403, 404, 410])(
		"retries once with the slash toggled on %i, both directions",
		async (status) => {
			site({
				"https://a.test/feed/": status,
				"https://a.test/feed": { body: "ok text", type: "text/plain" },
			});
			const page = await fetchPage("https://a.test/feed/");
			expect(page.content).toBe("ok text");
			expect(page.note).toBe(
				`Fetched https://a.test/feed — https://a.test/feed/ answered ${status}.`
			);
			site({
				"https://a.test/x": status,
				"https://a.test/x/": { body: "ok text", type: "text/plain" },
			});
			expect((await fetchPage("https://a.test/x")).note).toContain("https://a.test/x/");
		}
	);

	it("sends the toggled address through the same URL guard", async () => {
		site({
			"https://a.test/feed/": 403,
			"https://a.test/feed": { body: "ok", type: "text/plain" },
		});
		await fetchPage("https://a.test/feed/");
		expect(isValidUrl).toHaveBeenCalledWith("https://a.test/feed", { blockInternalNetworks: true });
	});

	it("does not retry on the bare origin or on other statuses", async () => {
		site({ "https://a.test/": 403 });
		await expect(fetchPage("https://a.test/")).rejects.toThrow(/HTTP 403/);
		expect(contentFetch).toHaveBeenCalledTimes(1);
		contentFetch.mockClear();
		site({ "https://a.test/p": 500 });
		await expect(fetchPage("https://a.test/p")).rejects.toThrow("That URL answered 500.");
		expect(contentFetch).toHaveBeenCalledTimes(1);
	});

	it("tries only one extra address, and says so when both fail", async () => {
		site({ "https://a.test/feed/": 403, "https://a.test/feed": 403 });
		await expect(fetchPage("https://a.test/feed/")).rejects.toThrow(
			/trailing slash toggled was tried/
		);
		expect(contentFetch).toHaveBeenCalledTimes(2);
	});

	it("words each failure by status", () => {
		expect(statusFailureMessage(403, false)).toMatch(/refused this address.*at most one other/);
		expect(statusFailureMessage(404, false)).toMatch(/No page at this address.*homepage/);
		expect(statusFailureMessage(410, true)).toMatch(/HTTP 410.*slash/);
		expect(statusFailureMessage(500, false)).toBe("That URL answered 500.");
	});

	it("retries a 403 that the renderer also reported (playwright backend)", async () => {
		config.FETCH_BACKEND = "playwright";
		const { FetchStatusError } = await import("./status");
		site({ "https://a.test/feed/": 403, "https://a.test/feed": 403 });
		renderWithPlaywright.mockImplementation(async (u: string) => {
			if (u.endsWith("/")) throw new FetchStatusError(403);
			return {
				url: u,
				title: "t",
				content: "<p>x</p>",
				contentType: "text/html",
				backend: "playwright",
				extracted: true,
			};
		});
		const page = await fetchPage("https://a.test/feed/");
		expect(page.note).toContain("answered 403");
	});
});

describe("feeds", () => {
	beforeEach(() => {
		contentFetch.mockReset();
		renderWithPlaywright.mockReset();
		config.FETCH_BACKEND = "playwright";
	});

	it("reads RSS 2.0 as a compact list, stripping HTML and decoding entities", () => {
		const feed = feedOf(rss);
		expect(feed.text.split("\n")[0]).toBe("Feed: Il Post & co (https://www.ilpost.it/) — 2 items");
		expect(feed.text).toContain(
			"- Mon, 02 Nov 2026 10:00:00 +0000 — First & best — https://www.ilpost.it/a/ — Hello world & more"
		);
		expect(feed.text).toContain("- Second — https://www.ilpost.it/b/");
	});

	it("reads Atom and RDF", () => {
		expect(feedOf(atom).text).toBe(
			"Feed: Blog (https://b.test/) — 1 items\n- 2026-11-01T08:00:00Z — Post — https://b.test/p1 — Short text"
		);
		expect(feedOf(rdf).text).toContain("- 2026-10-01 — Item — https://o.test/1 — Desc");
	});

	it("caps items and clips summaries", () => {
		const items = Array.from(
			{ length: 150 },
			(_, i) =>
				`<item><title>T${i}</title><link>https://x.test/${i}</link><description>${"w ".repeat(300)}</description></item>`
		).join("");
		const text = feedOf(`<rss><channel><title>Big</title>${items}</channel></rss>`).text;
		expect(text.split("\n")).toHaveLength(MAX_FEED_ITEMS + 1);
		expect(text.split("\n")[0]).toContain("100 of 150 items");
		expect(text.split("\n")[1].length).toBeLessThan(300);
	});

	it("falls back for malformed or non-feed XML", () => {
		expect(parseFeed("<rss><channel>")).toBeNull();
		expect(parseFeed("<html><body>hi</body></html>")).toBeNull();
		expect(parseFeed("<rss><channel><title>No items</title></channel></rss>")).toBeNull();
	});

	it.each([
		["application/rss+xml; charset=UTF-8", rss],
		["application/atom+xml", atom],
		["text/xml", rdf],
		["application/xml", rss],
	])("returns %s as an extracted list without rendering", async (type, body) => {
		site({ "https://a.test/feed": { body, type } });
		const page = await fetchPage("https://a.test/feed");
		expect(page).toMatchObject({ extracted: true, feed: true, backend: "direct" });
		expect(page.content).toMatch(/^Feed: /);
		expect(renderWithPlaywright).not.toHaveBeenCalled();
	});

	it("leaves an XML body that is not a feed as delivered", async () => {
		site({ "https://a.test/data.xml": { body: "<data><a>1</a></data>", type: "application/xml" } });
		const page = await fetchPage("https://a.test/data.xml");
		expect(page.content).toBe("<data><a>1</a></data>");
		expect(page.feed).toBeUndefined();
	});
});

describe("feed discovery", () => {
	it("lists advertised feeds as absolute URLs, at most three", () => {
		const html = `<html><head><title>x</title>
<link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
<link rel='alternate' type='application/atom+xml' href='https://other.test/atom?a=1&amp;b=2'>
<link rel="stylesheet" href="/s.css">
<link rel="alternate" type="application/rss+xml" href="c">
<link rel="alternate" type="application/rss+xml" href="d">
</head><body></body></html>`;
		expect(discoverFeeds(html, "https://a.test/blog/")).toEqual([
			"https://a.test/feed.xml",
			"https://other.test/atom?a=1&b=2",
			"https://a.test/blog/c",
		]);
		expect(discoverFeeds("<html><head></head></html>", "https://a.test/")).toEqual([]);
	});
});
