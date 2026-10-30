import { describe, expect, it } from "vitest";
import { buildSnippet, hasWholeWord, queryTerms, textSearchString } from "./contentSearch";

const need = <T>(value: T | undefined): T => {
	if (value === undefined) throw new Error("expected a snippet");
	return value;
};

const marked = (s: { text: string; spans: [number, number][] }) =>
	s.spans.map(([a, b]) => s.text.slice(a, b));

describe("query reading", () => {
	it("finds terms, phrases and drops negations", () => {
		expect(queryTerms('Codice "Fiscale ITALIANO" -spam')).toEqual(["codice", "fiscale italiano"]);
		expect(queryTerms("Perché")).toEqual(["perche"]);
	});
	it("needs a word of two letters or digits", () => {
		expect(hasWholeWord("a")).toBe(false);
		expect(hasWholeWord("a -spam")).toBe(false);
		expect(hasWholeWord("a b2")).toBe(true);
		expect(hasWholeWord('"ab"')).toBe(true);
	});
	it("requires every plain word", () => {
		expect(textSearchString('codice fiscale -spam "a b"')).toBe('"codice" "fiscale" -"spam" "a b"');
		expect(textSearchString("a codice x")).toBe('"codice"');
	});
});

describe("buildSnippet", () => {
	it("marks the match ignoring case and accents, and strips markdown", () => {
		const s = need(
			buildSnippet(
				[
					{ id: "1", from: "system", content: "caffè" },
					{
						id: "2",
						from: "assistant",
						content: "## Title\nA **Caffè** and a [link](http://x) here",
					},
				],
				"CAFFE"
			)
		);
		expect(s.messageId).toBe("2");
		expect(s.text).toBe("Title A Caffè and a link here");
		expect(marked(s)).toEqual(["Caffè"]);
	});
	it("matches whole words only", () => {
		expect(
			buildSnippet([{ id: "1", from: "user", content: "concatenate" }], "cat")
		).toBeUndefined();
	});
	it("cuts a long message around the match and keeps spans aligned", () => {
		const content = `${"lorem ipsum ".repeat(60)}needle in the haystack ${"dolor sit ".repeat(60)}`;
		const s = need(buildSnippet([{ id: "1", from: "user", content }], "needle haystack"));
		expect(s.text.length).toBeLessThanOrEqual(170);
		expect(s.text.startsWith("… ")).toBe(true);
		expect(s.text.endsWith(" …")).toBe(true);
		expect(marked(s)).toEqual(["needle", "haystack"]);
	});
	it("extends a match over combining accents", () => {
		const s = need(
			buildSnippet([{ id: "1", from: "user", content: "un cafe\u0301 caldo" }], "cafe")
		);
		expect(marked(s)).toEqual(["cafe\u0301"]);
	});
	it("reads a bounded amount of a huge conversation", () => {
		const messages = Array.from({ length: 2000 }, (_, i) => ({
			id: String(i),
			from: "user",
			content: "x".repeat(1000) + (i === 1999 ? " needle" : ""),
		}));
		const began = Date.now();
		expect(buildSnippet(messages, "needle")).toBeUndefined();
		expect(Date.now() - began).toBeLessThan(1000);
	});
	it("returns nothing when no message holds a term", () => {
		expect(buildSnippet([{ id: "1", from: "user", content: "hello" }], "world")).toBeUndefined();
	});
});
