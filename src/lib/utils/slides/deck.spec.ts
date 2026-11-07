import { describe, it, expect } from "vitest";
import { countSlides, deckTitle, highlightFences, parseDeck } from "./deck";

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
