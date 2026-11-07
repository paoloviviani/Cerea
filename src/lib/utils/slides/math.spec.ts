import { describe, it, expect } from "vitest";
import katex from "katex";
import "katex/dist/contrib/mhchem.mjs";
import { readFileSync, readdirSync } from "node:fs";
import {
	buildKatexCss,
	globalizeNewcommands,
	mightHaveMath,
	renderMath,
	type KatexLike,
} from "./math";

const k = katex as unknown as KatexLike;
const html = (src: string) => renderMath(src, k, { mode: "html" });
const md = (src: string) => renderMath(src, k, { mode: "markdown" });

describe("renderMath delimiters", () => {
	it("renders inline dollar-delimited and backslash-paren math", () => {
		for (const src of ["a $x^2$ b", "a \\(x^2\\) b"]) {
			const out = html(src);
			expect(out.count).toBe(1);
			expect(out.text).toContain('<span class="katex">');
			expect(out.text).not.toContain("katex-display");
			expect(out.text.startsWith("a ")).toBe(true);
			expect(out.text.endsWith(" b")).toBe(true);
		}
	});

	it("renders display math in double dollars and backslash-brackets, across lines", () => {
		for (const src of ["$$\nx^2 + y^2\n$$", "\\[x^2 + y^2\\]"]) {
			const out = html(src);
			expect(out.count).toBe(1);
			expect(out.text).toContain("katex-display");
		}
	});

	it("handles aligned, matrix and cases environments", () => {
		const src = [
			"$$\\begin{aligned} a &= b + c \\\\ d &= e \\end{aligned}$$",
			"$$\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$$",
			"$$f(x) = \\begin{cases} 0 & x < 0 \\\\ 1 & x \\ge 0 \\end{cases}$$",
		].join("\n\n");
		const out = html(src);
		expect(out.count).toBe(3);
		expect(out.text).not.toContain("katex-error");
		expect(out.text).toContain("mtable");
	});

	it("keeps a newcommand for the rest of the deck, with arguments", () => {
		const out = html(
			"$\\newcommand{\\R}{\\mathbb{R}}\\R$ then later $\\R^2$ and $\\newcommand{\\v}[1]{\\vec{#1}} \\v{u}$"
		);
		expect(out.count).toBe(3);
		expect(out.text).not.toContain("katex-error");
		expect((out.text.match(/mathbb/g) ?? []).length).toBeGreaterThanOrEqual(2);
		expect(globalizeNewcommands("\\newcommand{\\R}[2]{a#1#2} \\R")).toBe(
			"\\gdef\\R#1#2{a#1#2} \\R"
		);
		expect(globalizeNewcommands("\\newcommand{\\bad")).toBe("\\newcommand{\\bad");
	});

	it("renders chemistry with ce (mhchem)", () => {
		const out = html("water is $\\ce{H2O}$ and $\\ce{CO2 + H2O -> H2CO3}$");
		expect(out.count).toBe(2);
		expect(out.text).not.toContain("katex-error");
		expect(out.text).toContain("mrel");
	});
});

describe("renderMath dollars", () => {
	it("leaves currency alone", () => {
		for (const src of [
			"It costs $5 and $10 in total",
			"Pay $5.",
			"Only $5",
			"from $100 to $200 a year",
		]) {
			const out = html(src);
			expect(out.count, src).toBe(0);
			expect(out.text).toBe(src);
		}
	});

	it("turns an escaped dollar into a literal one, and stops it opening a formula", () => {
		expect(html("costs \\$5 and \\$10").text).toBe("costs $5 and $10");
		expect(md("costs \\$5 and \\$10").text).toBe("costs \\$5 and \\$10");
		const mixed = html("\\$a and $b$");
		expect(mixed.count).toBe(1);
		expect(mixed.text.startsWith("$a and ")).toBe(true);
	});

	it("accepts padded dollars but not mixed padding", () => {
		expect(html("so $ x + 1 $ here").count).toBe(1);
		expect(html("so $ x$ here").count).toBe(0);
		expect(html("so $x $ here").count).toBe(0);
	});
});

describe("renderMath protection", () => {
	it("skips code fences, inline code, pre, code, style and script", () => {
		const src = [
			"```\n$x$ \\(y\\)\n```",
			"~~~\n$$z$$\n~~~",
			"use `$x$` here",
			"<pre>$a$</pre>",
			"<code>\\(b\\)</code>",
			"<style>.a::after{content:'$c$'}</style>",
			"<script>var s = '$d$'</script>",
		].join("\n");
		const out = html(src);
		expect(out.count).toBe(0);
		expect(out.text).toBe(src);
	});

	it("does not look inside tags and does not take a less-than in a formula for one", () => {
		const attr = html('<a title="$x$">link</a> $y$');
		expect(attr.count).toBe(1);
		expect(attr.text.startsWith('<a title="$x$">link</a> ')).toBe(true);
		const lt = html("if $a<b$ then $c$");
		expect(lt.count).toBe(2);
	});

	it("never throws, and shows the source in red for a formula KaTeX cannot read", () => {
		const out = html("bad $\\notacommand{$ and $\\frac{1}$ good $x$");
		expect(out.count).toBeGreaterThanOrEqual(1);
		expect(out.text).toContain("katex-error");
		expect(out.text).toContain("#cc0000");
		expect(out.text).toContain('<span class="katex">');
		const unclosed = html("half open $$x^2 and \\( y");
		expect(unclosed.count).toBe(0);
		expect(unclosed.text).toBe("half open $$x^2 and \\( y");
	});

	it("leaves a formula past the size limit as text", () => {
		const long = `$${"x".repeat(10_001)}$`;
		expect(html(long).text).toBe(long);
	});

	it("uses HTML-only output for Markdown decks, MathML too for HTML decks", () => {
		expect(html("$x$").text).toContain("<annotation");
		expect(md("$x$").text).not.toContain("<annotation");
	});

	it("is quick to rule out a deck without math", () => {
		expect(mightHaveMath("plain text")).toBe(false);
		expect(mightHaveMath("costs $5")).toBe(true);
		expect(mightHaveMath("\\(x\\)")).toBe(true);
		expect(mightHaveMath("\\[x\\]")).toBe(true);
	});
});

describe("buildKatexCss", () => {
	const css = readFileSync(
		new URL("../../../../node_modules/katex/dist/katex.min.css", import.meta.url),
		"utf8"
	);
	const dir = new URL("../../../../node_modules/katex/dist/fonts/", import.meta.url);
	const fonts = Object.fromEntries(
		readdirSync(dir)
			.filter((f) => f.endsWith(".woff2"))
			.map((f) => [f, `data:font/woff2;base64,${readFileSync(new URL(f, dir)).toString("base64")}`])
	);

	it("inlines woff2 only, as data URIs, with no remote or relative font left", () => {
		const out = buildKatexCss(css, fonts, '<span class="katex mathnormal mainrm">x</span>');
		expect(out).toContain("data:font/woff2;base64,");
		expect(out).not.toMatch(/url\(fonts\//);
		expect(out).not.toMatch(/\.(woff|ttf)\b/);
		expect(out).not.toMatch(/https?:/);
		expect(out).toContain(".katex{");
	});

	it("keeps only the font families the formulas can use", () => {
		const plain = buildKatexCss(css, fonts, '<span class="katex mathnormal">x</span>');
		const face = (css: string, family: string) =>
			new RegExp(`@font-face\\{[^}]*font-family:"?${family}"?[;}]`).test(css);
		expect(face(plain, "KaTeX_Main")).toBe(true);
		expect(face(plain, "KaTeX_Math")).toBe(true);
		expect(face(plain, "KaTeX_AMS")).toBe(false);
		expect(face(plain, "KaTeX_Fraktur")).toBe(false);
		const blackboard = buildKatexCss(css, fonts, '<span class="mathbb">R</span>');
		expect(face(blackboard, "KaTeX_AMS")).toBe(true);
		expect(blackboard.length).toBeGreaterThan(plain.length);
	});
});
