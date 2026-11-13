import { describe, expect, it } from "vitest";
import { extractMainLinks, formatLinks, MAX_LINKS, MAX_LINKS_BYTES } from "./links";

const BASE = "https://news.example.test/front/";

const page = (body: string) => `<html><body>${body}</body></html>`;

describe("extractMainLinks", () => {
	it("returns text and absolute URLs, deduplicated, in page order", () => {
		const links = extractMainLinks(
			page(`<main>
				<a href="/story/one">Story   one</a>
				<a href="story/two#comments">Story two</a>
				<a href="/story/one">Story one again</a>
				<a href="https://other.example.test/x">Elsewhere</a>
			</main>`),
			BASE
		);
		expect(links).toEqual([
			{ text: "Story one", url: "https://news.example.test/story/one" },
			{ text: "Story two", url: "https://news.example.test/front/story/two" },
			{ text: "Elsewhere", url: "https://other.example.test/x" },
		]);
	});

	it("skips javascript, mailto, anchors, empty text and boilerplate", () => {
		const links = extractMainLinks(
			page(`<main>
				<a href="javascript:void(0)">Open the thing</a>
				<a href="mailto:a@b.test">Write to us</a>
				<a href="tel:+123">Call</a>
				<a href="#top">Back to top</a>
				<a href="/x"><img src="a.png"></a>
				<a href="/login">Log in</a>
				<a href="/s/real">A real story</a>
			</main>`),
			BASE
		);
		expect(links.map((l) => l.text)).toEqual(["A real story"]);
	});

	it("skips navigation, footer, aside and furniture by class", () => {
		const links = extractMainLinks(
			page(`
				<nav><a href="/world">World section</a></nav>
				<div class="site-menu"><a href="/menu">Menu entry</a></div>
				<div id="cookie-banner"><a href="/cookies">Cookie details</a></div>
				<section><a href="/s/headline">Headline of the day</a></section>
				<aside><a href="/promo">Promoted offer</a></aside>
				<footer><a href="/imprint">Imprint page</a></footer>`),
			BASE
		);
		expect(links.map((l) => l.text)).toEqual(["Headline of the day"]);
	});

	it("keeps links outside main when main holds almost nothing", () => {
		const links = extractMainLinks(
			page(
				`<main><a href="/a">Only one</a></main><div><a href="/b">Second</a><a href="/c">Third</a></div>`
			),
			BASE
		);
		expect(links.map((l) => l.text)).toEqual(["Only one", "Second", "Third"]);
	});

	it("returns nothing for a page without links or for junk", () => {
		expect(extractMainLinks(page("<p>text</p>"), BASE)).toEqual([]);
		expect(extractMainLinks("", BASE)).toEqual([]);
	});
});

describe("extractMainLinks: what a reader cannot see or trust", () => {
	it("skips hidden and inert elements", () => {
		const links = extractMainLinks(
			page(`<main>
				<a href="/a" hidden>Hidden attr</a>
				<div style="display:none"><a href="/b">Display none</a></div>
				<div style="VISIBILITY: hidden"><a href="/c">Visibility hidden</a></div>
				<div inert><a href="/d">Inert block</a></div>
				<a href="/e">Visible story</a>
			</main>`),
			BASE
		);
		expect(links.map((l) => l.text)).toEqual(["Visible story"]);
	});

	it("strips bidi and zero-width characters and drops text that is an address", () => {
		const links = extractMainLinks(
			page(`<main>
				<a href="/a">Pay\u202e txt\u200bbill</a>
				<a href="/b">https://bank.example/login</a>
				<a href="/c">Ordinary story</a>
			</main>`),
			BASE
		);
		expect(links.map((l) => l.text)).toEqual(["Pay txtbill", "Ordinary story"]);
	});

	it("skips very long addresses and honours <base href>", () => {
		const links = extractMainLinks(
			`<html><head><base href="https://cdn.example.test/dir/"></head><body><main>
				<a href="/${"x".repeat(400)}">Tracking link</a>
				<a href="item">Relative item</a></main></body></html>`,
			BASE
		);
		expect(links).toEqual([{ text: "Relative item", url: "https://cdn.example.test/dir/item" }]);
	});
});

describe("formatLinks", () => {
	it("labels the block and lists text: address", () => {
		const out = formatLinks([{ text: "One", url: "https://a.test/1" }]);
		expect(out).toBe("Main links on this page, as text: address:\n- One: https://a.test/1");
	});

	it("is empty for no links", () => {
		expect(formatLinks([])).toBe("");
	});

	it("caps at the count and the byte size, and says how many were kept", () => {
		const many = Array.from({ length: 200 }, (_, i) => ({
			text: `Headline number ${i}`,
			url: `https://a.test/story/${i}`,
		}));
		const out = formatLinks(many);
		const lines = out.split("\n").slice(1);
		expect(lines.length).toBeLessThanOrEqual(MAX_LINKS);
		expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_LINKS_BYTES);
		expect(out.split("\n")[0]).toContain(`(${lines.length} of 200)`);

		// An over-long entry is skipped, not the end of the list.
		const mixed = [
			{ text: "x".repeat(100), url: `https://a.test/${"p".repeat(4050)}` },
			{ text: "Short", url: "https://a.test/short" },
		];
		expect(formatLinks(mixed)).toContain("- Short: https://a.test/short");

		const long = Array.from({ length: 30 }, (_, i) => ({
			text: "x".repeat(100),
			url: `https://a.test/${"p".repeat(150)}/${i}`,
		}));
		expect(Buffer.byteLength(formatLinks(long))).toBeLessThanOrEqual(MAX_LINKS_BYTES);
	});
});
