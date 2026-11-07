/**
 * The vector PDF from a real Chromium: page count (vertical slides included),
 * selectable text, math as text. Needs a Chromium that Playwright can launch;
 * without one the file is skipped (the e2e suite covers the same path through
 * the app with the renderer service stood in).
 */
import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";

// vitest serves stylesheets imported with ?raw as empty text, so each one is read from disk here
vi.mock("reveal.js/dist/reveal.css?raw", async () => ({
	default: (await import("node:fs")).readFileSync("node_modules/reveal.js/dist/reveal.css", "utf8"),
}));
vi.mock("reveal.js/dist/reset.css?raw", async () => ({
	default: (await import("node:fs")).readFileSync("node_modules/reveal.js/dist/reset.css", "utf8"),
}));
vi.mock("katex/dist/katex.min.css?raw", async () => ({
	default: (await import("node:fs")).readFileSync("node_modules/katex/dist/katex.min.css", "utf8"),
}));
vi.mock("$lib/utils/slides/slides.css?raw", async () => ({
	default: (await import("node:fs")).readFileSync("src/lib/utils/slides/slides.css", "utf8"),
}));
vi.mock("./slides.css?raw", async () => ({
	default: (await import("node:fs")).readFileSync("src/lib/utils/slides/slides.css", "utf8"),
}));
vi.mock("./neutral.css?raw", async () => ({
	default: (await import("node:fs")).readFileSync("src/lib/utils/slides/neutral.css", "utf8"),
}));
vi.mock("./cerea-theme.css?raw", async () => ({
	default: (await import("node:fs")).readFileSync("src/lib/utils/slides/cerea-theme.css", "utf8"),
}));

import { chromium } from "playwright";
import { buildPrintDocument } from "./document";
import { renderDeckPdf } from "./renderPdf";

const hasChromium = (() => {
	try {
		return existsSync(chromium.executablePath());
	} catch {
		return false;
	}
})();

async function readPdf(pdf: Buffer): Promise<{ pages: number; text: string }> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true }).promise;
	let text = "";
	for (let i = 1; i <= doc.numPages; i++) {
		const content = await (await doc.getPage(i)).getTextContent();
		text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
	}
	return { pages: doc.numPages, text };
}

const launch = () => chromium.launch();

describe.skipIf(!hasChromium)("renderDeckPdf in a real browser", () => {
	it("makes one page per slide, vertical stacks included, with text you can select", async () => {
		const deck = [
			"<section><h1>Quarterly review</h1><aside class='notes'>secret note</aside></section>",
			"<section><section><h2>Stack top</h2></section><section><h2>Stack bottom</h2></section></section>",
			"<section><p>Last slide</p></section>",
		].join("");
		const { html } = await buildPrintDocument({ content: deck, print: {} });
		const pdf = await renderDeckPdf(html, { connect: launch });
		expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
		const read = await readPdf(pdf);
		expect(read.pages).toBe(4);
		for (const phrase of ["Quarterly review", "Stack top", "Stack bottom", "Last slide"]) {
			expect(read.text).toContain(phrase);
		}
		// Notes are only printed when asked for
		expect(read.text).not.toContain("secret note");
	}, 60_000);

	it("prints the speaker notes on pages of their own when asked", async () => {
		const deck = "<section><h1>One</h1><aside class='notes'>secret note</aside></section>";
		const { html } = await buildPrintDocument({ content: deck, print: { notes: true } });
		const read = await readPdf(await renderDeckPdf(html, { connect: launch }));
		expect(read.text).toContain("secret note");
	}, 60_000);

	it("keeps math as text, and a Markdown deck works too", async () => {
		const md =
			"# Energy\n\nIt is $E=mc^2$ and costs $5 and $10.\n\n---\n\n## Chemistry\n\n$\\ce{H2O}$";
		const { html } = await buildPrintDocument({ content: md, print: {} });
		const read = await readPdf(await renderDeckPdf(html, { connect: launch }));
		expect(read.pages).toBe(2);
		expect(read.text).toContain("Energy");
		expect(read.text).toContain("costs $5 and $10");
		expect(read.text.replace(/\s+/g, "")).toContain("mc");
		expect(read.text).toContain("Chemistry");
	}, 60_000);

	it("lets nothing reach the network, even a page that was not tidied first", async () => {
		const finished: string[] = [];
		const { html } = await buildPrintDocument({ content: "<section>Fetch</section>", print: {} });
		// Put what the tidying would have removed straight into the document
		const hostile = html.replace(
			"</body>",
			`<img src="https://tracker.test/p.png"><script>fetch("https://tracker.test/s"); new Image().src = "https://tracker.test/i"</script></body>`
		);
		expect(hostile).toContain("tracker.test");
		const spy = async () => {
			const browser = await chromium.launch();
			const original = browser.newContext.bind(browser);
			browser.newContext = (async (...args: Parameters<typeof original>) => {
				const context = await original(...args);
				context.on("requestfinished", (r) => finished.push(r.url()));
				return context;
			}) as typeof browser.newContext;
			return browser;
		};
		await renderDeckPdf(hostile, { connect: spy });
		expect(finished.filter((u) => u.includes("tracker.test"))).toEqual([]);
	}, 60_000);
});
