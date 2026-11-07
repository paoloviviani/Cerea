import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildSlidesSrcdoc, stripImports, themeCss } from "./srcdoc";
import { BUILTIN_THEME_IDS } from "./themes";
import { PREVIEW_SANDBOX } from "../previewSrcdoc";

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

describe("buildSlidesSrcdoc", () => {
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
		const hostile = buildSlidesSrcdoc("# x </textarea><script>alert(1)</script> & y", "c");
		const body = hostile.slice(hostile.indexOf("<textarea data-template>"));
		expect(body).toContain("&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; y");
		expect(body.indexOf("</textarea>")).toBeGreaterThan(body.indexOf("&amp; y"));
	});

	it("uses the sanitised title and puts the notes separator on Note:", () => {
		expect(doc).toContain("<title>A b</title>");
		expect(doc).toContain('data-separator-notes="^Note:"');
	});

	it("shows an org logo as an image tag and ignores a bare file name", () => {
		const withLogo = buildSlidesSrcdoc("# x", "c", { org: { logo: "data:image/png;base64,AA==" } });
		expect(withLogo).toContain('<img class="cerea-logo"');
		const named = buildSlidesSrcdoc("---\nlogo: logo.png\n---\n# x", "c");
		expect(named).not.toContain('cerea-logo"');
		const resolved = buildSlidesSrcdoc("---\nlogo: logo.png\n---\n# x", "c", {
			logoDataUrl: "data:image/png;base64,AA==",
		});
		expect(resolved).toContain('<img class="cerea-logo"');
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

	it("themeCss gives a Cerea theme its own typography file", () => {
		expect(typeof themeCss("cerea")).toBe("string");
	});
});
