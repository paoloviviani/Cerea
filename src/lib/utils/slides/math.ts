/**
 * LaTeX in slides (ADR 0111), rendered with KaTeX before the deck goes into
 * the sandbox, the way code is pre-highlighted: the frame then holds finished
 * HTML and CSS and runs no math JavaScript. Pure functions; the KaTeX module
 * is passed in so this file stays cheap to import and easy to test.
 *
 * Delimiters: `$...$`, `$$...$$`, `\(...\)`, `\[...\]`. Not touched: fenced
 * code, inline code, `<pre>`, `<code>`, `<style>`, `<script>` and the inside
 * of HTML tags. `\$` stays a literal dollar. Currency follows the chat
 * renderer's rules: `$5 and $10` is text, because a single-dollar formula must
 * be tight on both sides (`$x$`) or padded on both (`$ x $`), and its closing
 * `$` is never followed by a digit.
 */

export interface KatexLike {
	renderToString(
		tex: string,
		options: {
			throwOnError: boolean;
			displayMode: boolean;
			errorColor?: string;
			output?: "html" | "mathml" | "htmlAndMathml";
			macros?: Record<string, unknown>;
			strict?: string | boolean;
			trust?: boolean;
			maxExpand?: number;
			maxSize?: number;
		}
	): string;
}

/** What a deck needs to show math: the renderer and the stylesheet that goes with it. */
export interface MathSupport {
	katex: KatexLike;
	/** KaTeX's CSS with fonts inlined, trimmed to the families the rendered HTML uses */
	css(renderedHtml: string): string;
}

/** A cheap test before paying for the KaTeX chunk: could this deck hold math at all? */
export function mightHaveMath(source: string): boolean {
	return /\$|\\[([]/.test(source);
}

/** Same ceiling the chat renderer uses: longer sources are left as text. */
export const MAX_MATH_LENGTH = 10_000;
/** A deck cannot make the parent render an unbounded number of formulas. */
export const MAX_FORMULAS = 400;

const PROTECTED =
	/(```[\s\S]*?```|~~~[\s\S]*?~~~|<(pre|code|style|script)\b[\s\S]*?<\/\2\s*>|<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>|`[^`\n]*`)/gi;

// Order matters: an escaped dollar, then $$, \[, \(, then single dollars.
const MATH =
	/\\\$|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?:(?!\s)([^$\n]+?)(?<!\s)|\s([^$\n]+?)\s)\$(?!\d)/g;

export interface MathResult {
	text: string;
	/** How many formulas were rendered (0 means no KaTeX CSS is needed) */
	count: number;
}

export interface RenderMathOptions {
	/** Markdown decks get HTML-only output: MathML's TeX annotation would be read as Markdown */
	mode: "html" | "markdown";
}

/**
 * Replace the math in `source` with KaTeX HTML. `\newcommand`, `\def` and
 * `\gdef` in one formula carry on to the next (one macro table per call).
 * A formula KaTeX cannot parse is shown as its source in red, never thrown.
 */
export function renderMath(
	source: string,
	katex: KatexLike,
	{ mode }: RenderMathOptions
): MathResult {
	if (!/[$\\]/.test(source)) return { text: source, count: 0 };
	const macros: Record<string, unknown> = {};
	let count = 0;
	const render = (tex: string, displayMode: boolean, raw: string): string => {
		const body = tex.trim();
		if (!body || body.length > MAX_MATH_LENGTH || count >= MAX_FORMULAS) return raw;
		count++;
		try {
			return katex.renderToString(globalizeNewcommands(body), {
				throwOnError: false,
				displayMode,
				errorColor: "#cc0000",
				output: mode === "markdown" ? "html" : "htmlAndMathml",
				macros,
				strict: "ignore",
				trust: false,
				maxExpand: 1000,
			});
		} catch {
			// throwOnError is false, so this is a bug in KaTeX, not a bad formula
			return `<span class="katex-error" style="color:#cc0000">${escapeHtml(raw)}</span>`;
		}
	};
	const parts = source.split(PROTECTED);
	// split() with two capture groups interleaves: text, whole, tagName, text, ...
	let out = "";
	for (let i = 0; i < parts.length; i += 3) {
		const text = parts[i];
		out += text.replace(
			MATH,
			(raw, dd?: string, br?: string, par?: string, tight?: string, padded?: string) => {
				if (raw === "\\$") return mode === "markdown" ? raw : "$";
				if (dd !== undefined) return render(dd, true, raw);
				if (br !== undefined) return render(br, true, raw);
				if (par !== undefined) return render(par, false, raw);
				return render((tight ?? padded) as string, false, raw);
			}
		);
		if (i + 1 < parts.length) out += parts[i + 1];
	}
	return { text: out, count };
}

/**
 * KaTeX's `\newcommand` only lasts for its own formula. A definition on one
 * slide is meant for the rest of the deck, so each one is rewritten as the
 * equivalent `\gdef`, which KaTeX keeps in the shared macro table:
 * `\newcommand{\R}[1]{...}` becomes `\gdef\R#1{...}`. Anything that does not
 * parse (an unbalanced body, a missing name) is left for KaTeX to report.
 */
export function globalizeNewcommands(tex: string): string {
	const head = /\\(?:re)?newcommand\*?\s*/g;
	let out = "";
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = head.exec(tex))) {
		let i = m.index + m[0].length;
		const named = /^\{\s*(\\[a-zA-Z]+)\s*\}|^(\\[a-zA-Z]+)/.exec(tex.slice(i));
		if (!named) continue;
		const name = named[1] ?? named[2];
		i += named[0].length;
		const args = /^\s*\[(\d)\]/.exec(tex.slice(i));
		let params = "";
		if (args) {
			for (let n = 1; n <= Number(args[1]); n++) params += `#${n}`;
			i += args[0].length;
		}
		while (/\s/.test(tex[i] ?? "")) i++;
		if (tex[i] !== "{") continue;
		let depth = 0;
		let j = i;
		for (; j < tex.length; j++) {
			if (tex[j] === "\\") j++;
			else if (tex[j] === "{") depth++;
			else if (tex[j] === "}" && --depth === 0) break;
		}
		if (depth !== 0) continue;
		out += tex.slice(last, m.index) + `\\gdef${name}${params}${tex.slice(i, j + 1)}`;
		last = j + 1;
		head.lastIndex = last;
	}
	return out + tex.slice(last);
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * KaTeX's stylesheet with its fonts inlined as `data:` URIs, woff2 only (the
 * preview sandbox's CSP allows fonts from `data:` and nothing else). Only the
 * font families the rendered HTML can use are included, which keeps a typical
 * deck to a fraction of the 300 kB all of them weigh.
 *
 * `fonts` maps a file name (`KaTeX_Main-Regular.woff2`) to its data URI.
 */
export function buildKatexCss(
	css: string,
	fonts: Record<string, string>,
	renderedHtml: string
): string {
	// Which families a formula's HTML can reach. Main and Math are always in.
	const needs: Record<string, RegExp> = {
		KaTeX_AMS: /\b(amsrm|mathbb|textbb)\b|class="[^"]*\bmathbb\b/,
		KaTeX_Caligraphic: /\bmathcal\b/,
		KaTeX_Fraktur: /\b(mathfrak|textfrak|mathboldfrak|textboldfrak)\b/,
		KaTeX_SansSerif: /\b(textsf|mathsf|mathboldsf|mathitsf|mathsfit|textboldsf|textitsf)\b/,
		KaTeX_Script: /\b(mathscr|textscr)\b/,
		KaTeX_Size1: /\b(size1|small-op)\b/,
		KaTeX_Size2: /\b(size2|large-op)\b/,
		KaTeX_Size3: /\bsize3\b/,
		KaTeX_Size4: /\b(size4|delim-size4)\b/,
		KaTeX_Typewriter: /\b(texttt|mathtt)\b/,
	};
	return css.replace(/@font-face\{[^}]*\}/g, (block) => {
		const family = /font-family:"?([A-Za-z_0-9]+)"?/.exec(block)?.[1] ?? "";
		const file = /url\(fonts\/([^)]+\.woff2)\)/.exec(block)?.[1];
		const data = file ? fonts[file] : undefined;
		if (!data) return "";
		const test = needs[family];
		if (test && !test.test(renderedHtml)) return "";
		return block.replace(/src:[^;}]*/, `src:url(${data}) format("woff2")`);
	});
}
