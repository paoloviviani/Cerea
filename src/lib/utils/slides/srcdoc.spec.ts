import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import katex from "katex";
import { buildSlidesSrcdoc, engineCss, stripImports } from "./srcdoc";
import { BUILTIN_THEME_IDS } from "./themes";
import { PREVIEW_SANDBOX } from "../previewSrcdoc";
import { buildKatexCss, type KatexLike, type MathSupport } from "./math";

describe("stripImports", () => {
	it("removes @import rules, remote and local", () => {
		const css = `@import url(./fonts/a.css);\n@import url(https://fonts.googleapis.com/css?family=Lato);\nbody{color:red}`;
		expect(stripImports(css).trim()).toBe("body{color:red}");
	});

	it.each(BUILTIN_THEME_IDS)("leaves reveal's %s theme with no import and no remote URL", (id) => {
		const raw = readFileSync(
			new URL(`../../../../node_modules/reveal.js/dist/theme/${id}.css`, import.meta.url),
			"utf8"
		);
		const css = stripImports(raw);
		expect(css).not.toMatch(/@import/);
		expect(css).not.toMatch(/https?:\/\//);
		expect(css).not.toMatch(/url\(/);
	});
});

describe("engineCss", () => {
	it("removes the viewport's colour and line-height defaults from reveal.css", async () => {
		const { default: css } = await import("reveal.js/dist/reveal.css?raw");
		// vitest serves css as an empty string; the real package file is read directly
		const real = readFileSync(
			new URL("../../../../node_modules/reveal.js/dist/reveal.css", import.meta.url),
			"utf8"
		);
		void css;
		const out = engineCss(real);
		const viewport = /\.reveal-viewport\{[^}]*\}/.exec(out)?.[0] ?? "";
		expect(viewport).toContain("overflow:hidden");
		expect(viewport).not.toMatch(/background-color|line-height|color:#000/);
	});
});

describe("buildSlidesSrcdoc, Markdown", () => {
	const doc = buildSlidesSrcdoc("---\ntitle: A <b>\n---\n# One\n\n---\n\n# Two\n", "chan1");

	it("is a self-contained document under the preview CSP", () => {
		expect(doc).toContain("Content-Security-Policy");
		expect(doc).toContain("default-src 'none'");
		expect(doc).not.toMatch(/<script[^>]*\ssrc=/i);
		expect(doc).not.toMatch(/<link\b/i);
		expect(doc).toContain("chatui.slides.state");
		expect(PREVIEW_SANDBOX).not.toContain("allow-same-origin");
	});

	it("carries the Markdown in a textarea, escaped so it cannot close it", () => {
		const hostile = buildSlidesSrcdoc("# x </textarea><b>bold</b> & y", "c");
		const body = hostile.slice(hostile.indexOf("<textarea data-template>"));
		expect(body).toContain("&lt;/textarea&gt;&lt;b&gt;bold&lt;/b&gt; &amp; y");
		expect(body.indexOf("</textarea>")).toBeGreaterThan(body.indexOf("&amp; y"));
	});

	it("uses the sanitised title and puts the notes separator on Note:", () => {
		expect(doc).toContain("<title>A b</title>");
		expect(doc).toContain('data-separator-notes="^Note:"');
	});

	it("shows a logo as an image tag (Markdown only) and ignores a bare file name", () => {
		const withLogo = buildSlidesSrcdoc("# x", "c", { org: { logo: "data:image/png;base64,AA==" } });
		expect(withLogo).toContain('<img class="cerea-logo"');
		const named = buildSlidesSrcdoc("---\nlogo: logo.png\n---\n# x", "c");
		expect(named).not.toContain('cerea-logo"');
		const resolved = buildSlidesSrcdoc("---\nlogo: logo.png\n---\n# x", "c", {
			logoDataUrl: "data:image/png;base64,AA==",
		});
		expect(resolved).toContain('<img class="cerea-logo"');
		expect(resolved).toContain('--brand-logo-url:url("data:image/png;base64,AA==")');
	});

	it("includes only the chosen theme's resolved variables", () => {
		const d = buildSlidesSrcdoc("---\ntheme: black\naccent: #ff0000\n---\n# x", "c");
		expect(d).toContain("--r-link-color:#ff0000");
		expect(d).not.toContain("--r-background-color:#111827");
	});

	it("builds the PDF variant without keyboard or fragments", () => {
		const d = buildSlidesSrcdoc("# x", "c", { pdf: true });
		expect(d).toContain("var PDF = true");
	});
});

/** The slides' markup: from the reveal container to the first engine script. */
function markupOf(doc: string): string {
	const start = doc.indexOf('<div class="reveal">');
	return doc.slice(start, doc.indexOf("<script>", start));
}

describe("buildSlidesSrcdoc, HTML", () => {
	const fixture = readFileSync(new URL("./fixtures/talk-deck.html", import.meta.url), "utf8");
	const doc = buildSlidesSrcdoc(fixture, "chan2", {
		org: { accent: "#0a7e8c", logo: "data:image/png;base64,AA==" },
	});

	it("puts the model's sections and style straight into the slides, with no markdown plugin work", () => {
		const markup = markupOf(doc);
		expect(markup).toContain('<div class="slides">');
		expect(markup).not.toContain("data-markdown");
		expect(doc).toContain("data-background-gradient");
		expect(doc).toContain(".flow .step");
		expect(doc).toContain('<aside class="notes">');
	});

	it("starts reveal at 1280x720, not centred, with no margin", () => {
		expect(doc).toContain("width: 1280, height: 720, margin: MD && !PDF ? 0.04 : 0");
		expect(doc).toContain("var MD = false");
		expect(doc).toContain("center: MD");
	});

	it("applies no theme but defines the brand variables", () => {
		expect(doc).toContain("--brand-accent:#0a7e8c");
		expect(doc).toContain("--brand-logo-url");
		expect(doc).not.toContain("--r-background-color:");
		expect(doc).not.toContain('class="cerea-logo"');
	});

	it("removes a model's script and remote loads before they reach the frame", () => {
		const d = buildSlidesSrcdoc(
			'<section><script>steal()</script><img src="https://evil.test/x.png" onerror="x()"></section>',
			"c"
		);
		const markup = markupOf(d);
		expect(markup).not.toContain("steal()");
		expect(markup).not.toContain("evil.test");
		expect(markup).not.toContain("onerror");
	});

	it("binds the S key to the notes drawer", () => {
		expect(doc).toContain("ev.key === 's'");
	});
});

describe("buildSlidesSrcdoc, math", () => {
	const root = new URL("../../../../node_modules/katex/dist/", import.meta.url);
	const css = readFileSync(new URL("katex.min.css", root), "utf8");
	const fonts = Object.fromEntries(
		readdirSync(new URL("fonts/", root))
			.filter((f) => f.endsWith(".woff2"))
			.map((f) => [
				f,
				`data:font/woff2;base64,${readFileSync(new URL(`fonts/${f}`, root)).toString("base64")}`,
			])
	);
	const math: MathSupport = {
		katex: katex as unknown as KatexLike,
		css: (rendered) => buildKatexCss(css, fonts, rendered),
	};

	it("renders formulas in an HTML deck and inlines the stylesheet with data: fonts", () => {
		const d = buildSlidesSrcdoc("<section>Energy $E=mc^2$</section>", "c", { math });
		const markup = markupOf(d);
		expect(markup).toContain('<span class="katex">');
		expect(d).toContain("data:font/woff2;base64,");
		expect(d).not.toMatch(/url\(fonts\//);
		expect(d).not.toMatch(/src:url\(https?:/);
	});

	it("renders formulas in a Markdown deck, inside the escaped textarea", () => {
		const d = buildSlidesSrcdoc("# Math\n\n$$x^2$$\n\n---\n\nand $y$", "c", { math });
		const area = d.slice(d.indexOf("<textarea data-template>"), d.indexOf("</textarea>"));
		expect(area).toContain("&lt;span class=");
		expect(area).toContain("katex-display");
		expect(area).not.toContain("<span");
	});

	it("adds no KaTeX CSS to a deck without formulas, nor without the support", () => {
		const plain = buildSlidesSrcdoc("<section>costs $5 and $10</section>", "c", { math });
		expect(plain).not.toContain("data:font/woff2");
		expect(plain).toContain("costs $5 and $10");
		const without = buildSlidesSrcdoc("<section>$x$</section>", "c");
		expect(without).toContain("$x$");
	});

	it("keeps the deck whole when a formula is broken: the source shows in red", () => {
		const d = buildSlidesSrcdoc(
			"<section>ok $x$ bad $\\notacommand{$</section><section>next</section>",
			"c",
			{
				math,
			}
		);
		expect(markupOf(d)).toContain("katex-error");
		expect(markupOf(d)).toContain("<section>next</section>");
	});

	it("also renders math in the print variant (and the picture-PDF frame)", () => {
		for (const opts of [{ print: { notes: false } }, { pdf: true }]) {
			const d = buildSlidesSrcdoc("<section>$a+b$</section>", "c", { math, ...opts });
			expect(markupOf(d)).toContain('<span class="katex">');
		}
	});
});

describe("buildSlidesSrcdoc, print", () => {
	it("carries its own content policy and starts reveal's print layout wait", () => {
		const d = buildSlidesSrcdoc("<section>a</section><section>b</section>", "", {
			print: { notes: true, auto: true, labels: { print: "Print <it>", hint: "hint" } },
		});
		expect(d).toContain('http-equiv="Content-Security-Policy"');
		expect(d).toContain("default-src 'none'");
		expect(d).toContain('"notes":true');
		expect(d).toContain("showNotes: PRINT && PRINT.notes ? 'separate-page'");
		expect(d).toContain("data-print-ready");
		expect(d).toContain("cerea-print");
		expect(d).toContain("Print &lt;it&gt;");
		expect(d).not.toContain("chatui.preview.error");
	});

	it("has no print bar unless asked, and no preview hook without a channel", () => {
		const d = buildSlidesSrcdoc("<section>a</section>", "", { print: { auto: false } });
		expect(d).not.toContain('id="cerea-print"');
		expect(d).toContain('"auto":false');
	});
});
