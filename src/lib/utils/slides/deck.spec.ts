import { describe, it, expect } from "vitest";
import { countSlides, deckTitle, highlightFences, parseDeck, sanitizeHtmlDeck } from "./deck";

describe("parseDeck", () => {
	it("reads the known front matter keys and returns the body", () => {
		const deck = parseDeck(
			'---\ntitle: Q3 review\ntheme: Dracula\naccent: "#0A7"\nfont: serif\nlogo: logo.png\n---\n\n# Hello\n\n---\n\n## Two\n'
		);
		expect(deck.meta).toEqual({
			title: "Q3 review",
			theme: "dracula",
			accent: "#00aa77",
			font: "serif",
			logo: "logo.png",
		});
		expect(deck.body.startsWith("# Hello")).toBe(true);
		expect(deck.slideCount).toBe(2);
	});

	it("drops values that are not on the allowed lists", () => {
		const deck = parseDeck(
			"---\ntheme: neon\naccent: red; background:url(//evil)\nfont: Comic Sans\nlogo: https://evil.example/x.png\nunknown: 1\n---\n# A\n"
		);
		expect(deck.meta).toEqual({});
	});

	it("rejects CSS-looking and path-like logo values, accepts data URLs of images", () => {
		expect(parseDeck("---\nlogo: ../../etc/passwd\n---\n# A").meta.logo).toBeUndefined();
		expect(parseDeck('---\nlogo: a.png"onerror=x\n---\n# A').meta.logo).toBeUndefined();
		expect(parseDeck("---\nlogo: data:text/html;base64,AAAA\n---\n# A").meta.logo).toBeUndefined();
		expect(parseDeck("---\nlogo: data:image/png;base64,iVBORw0KGgo=\n---\n# A").meta.logo).toBe(
			"data:image/png;base64,iVBORw0KGgo="
		);
	});

	it("treats a leading block that is not key: value as slides, not front matter", () => {
		const deck = parseDeck("---\n# Title\n---\n## Next\n");
		expect(deck.meta).toEqual({});
		expect(deck.body).toContain("# Title");
		expect(deck.slideCount).toBe(2);
	});

	it("works without front matter and with CRLF line endings", () => {
		const deck = parseDeck("# One\r\n\r\n---\r\n\r\n# Two\r\n");
		expect(deck.meta).toEqual({});
		expect(deck.slideCount).toBe(2);
	});

	it("leaves an unterminated front matter block as body", () => {
		const deck = parseDeck("---\ntheme: black\n# Oops\n");
		expect(deck.meta).toEqual({});
	});
});

describe("countSlides", () => {
	it("ignores empty slides and counts at least one", () => {
		expect(countSlides("")).toBe(1);
		expect(countSlides("a\n---\n\n---\nb")).toBe(2);
	});
});

describe("deckTitle", () => {
	it("prefers the title, then the first heading, then the fallback", () => {
		expect(deckTitle(parseDeck("---\ntitle: T\n---\n# H"))).toBe("T");
		expect(deckTitle(parseDeck("# **Bold** heading\n"))).toBe("Bold heading");
		expect(deckTitle(parseDeck("no heading"))).toBe("slides");
	});
});

describe("highlightFences", () => {
	const fake = (code: string, lang?: string) => `[${lang}]${code.toUpperCase()}`;

	it("replaces fenced blocks with pre-highlighted HTML", () => {
		const out = highlightFences("a\n\n```python\nx = 1\n```\n\nb", fake);
		expect(out).toContain('<pre><code class="hljs language-python">[python]X = 1</code></pre>');
		expect(out.startsWith("a\n\n")).toBe(true);
	});

	it("escapes unlabelled blocks and protects a --- line inside code from the slide splitter", () => {
		const out = highlightFences("```\n<b>\n---\nend\n```", fake);
		expect(out).toContain("&lt;b&gt;");
		expect(out).toContain("<span>---</span>");
		expect(countSlides(out)).toBe(1);
	});
});

describe("HTML decks", () => {
	const html =
		'<style>.a{color:red}</style>\n<section><h1>One</h1><aside class="notes">n</aside></section>\n<section><section>2a</section><section>2b</section></section>';

	it("are recognised by their sections and keep style blocks and notes", () => {
		const deck = parseDeck(html);
		expect(deck.mode).toBe("html");
		expect(deck.body).toContain("<style>.a{color:red}</style>");
		expect(deck.body).toContain('<aside class="notes">');
		expect(deck.slideCount).toBe(4);
		expect(deckTitle(deck)).toBe("One");
		expect(deckTitle(parseDeck("<section><h1>A,<br>b</h1></section>"))).toBe("A, b");
	});

	it("take front matter, and a theme from data-theme", () => {
		expect(parseDeck("---\ntheme: moon\n---\n<section>x</section>").meta.theme).toBe("moon");
		expect(parseDeck('<section data-theme="Dracula">x</section>').meta.theme).toBe("dracula");
		expect(parseDeck('<section data-theme="evil;">x</section>').meta.theme).toBeUndefined();
		expect(parseDeck("<section>x</section>").meta.theme).toBeUndefined();
	});

	it("leave Markdown alone", () => {
		expect(parseDeck("# Hi\n\n---\n\n# There").mode).toBe("markdown");
	});
});

describe("sanitizeHtmlDeck", () => {
	it("removes scripts, handlers, remote loads and blocked tags, and counts them", () => {
		const { html, report } = sanitizeHtmlDeck(
			[
				"<!doctype html><html><head><title>t</title><link rel=stylesheet href=//x.test/a.css><meta charset=utf-8></head><body>",
				"<style>@import url(https://x.test/f.css); .b{background:url(https://x.test/i.png)} .c{background:url(data:image/png;base64,AA==)}</style>",
				'<section onclick="evil()"><script>alert(1)</script><img src="https://x.test/p.png" onerror=bad()>',
				'<img src="data:image/png;base64,AA==" alt="ok"><a href="javascript:alert(1)">x</a><a href="https://example.com">fine</a>',
				'<iframe src="https://x.test"></iframe><object data="x"></object></section></body></html>',
			].join("")
		);
		expect(html).not.toMatch(
			/<script|onclick|onerror|javascript:|<link|<meta|<iframe|<object|<html|<body|<title|@import|x\.test/i
		);
		expect(html).toContain("data:image/png;base64,AA==");
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain("<section");
		expect(report.scripts).toBe(1);
		expect(report.handlers).toBe(3);
		expect(report.blockedTags).toBe(4);
		expect(report.externalResources).toBe(3);
	});

	it("passes the designed fixture deck through with nothing stripped", async () => {
		const { readFileSync } = await import("node:fs");
		const fixture = readFileSync(new URL("./fixtures/talk-deck.html", import.meta.url), "utf8");
		const deck = parseDeck(fixture);
		expect(deck.mode).toBe("html");
		expect(deck.slideCount).toBe(5);
		expect(deck.stripped).toEqual({
			scripts: 0,
			handlers: 0,
			externalResources: 0,
			blockedTags: 0,
		});
	});
});
