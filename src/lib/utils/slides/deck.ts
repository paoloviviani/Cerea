/**
 * Parsing a slides artifact (ADR 0111): optional front matter, then reveal.js
 * Markdown. Only a fixed set of keys is read and every value is validated
 * (themes.ts), so the front matter is configuration, never a way in for CSS.
 */
import { sanitizeAccent, sanitizeFont, sanitizeLogo, sanitizeTheme, type DeckLook } from "./themes";

export interface DeckMeta extends DeckLook {
	title?: string;
}

export interface StripReport {
	/** `<script>` elements removed (the engine is Cerea's) */
	scripts: number;
	/** Inline event handlers (`onclick=` ...) and `javascript:` URLs removed */
	handlers: number;
	/** Remote `src`, `poster`, `srcset`, CSS `url()` and `@import` removed */
	externalResources: number;
	/** `<link>`, `<base>`, `<meta>`, `<iframe>`, `<object>`, `<embed>` removed */
	blockedTags: number;
}

export type DeckMode = "html" | "markdown";

export interface ParsedDeck {
	meta: DeckMeta;
	/** HTML `<section>` slides (the main format) or Markdown (the shortcut) */
	mode: DeckMode;
	/** The slides after the front matter; for HTML, already cleaned */
	body: string;
	/** What cleaning an HTML deck removed (zeros for Markdown) */
	stripped: StripReport;
	/** Number of slides: `<section>` count for HTML, `---` separators for Markdown */
	slideCount: number;
}

const NO_STRIP: StripReport = { scripts: 0, handlers: 0, externalResources: 0, blockedTags: 0 };

/**
 * Clean the model's HTML slides. The sandbox and its CSP already refuse
 * scripts from outside and every remote load; this removes them up front so
 * a deck cannot depend on them, and says how much it removed. Document
 * wrappers (`<html>`, `<head>`, `<body>`, doctype, `<title>`) are dropped but
 * `<style>` blocks stay.
 */
export function sanitizeHtmlDeck(html: string): { html: string; report: StripReport } {
	const report: StripReport = { ...NO_STRIP };
	const count = (key: keyof StripReport) => () => {
		report[key]++;
		return "";
	};
	const out = html
		.replace(/<!doctype[^>]*>/gi, "")
		.replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "")
		.replace(/<title\b[\s\S]*?<\/title\s*>/gi, "")
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, count("scripts"))
		.replace(/<\/?script\b[^>]*>/gi, count("scripts"))
		.replace(/<(?:link|base|meta)\b[^>]*>/gi, count("blockedTags"))
		.replace(
			/<(iframe|object|embed|frame|frameset|applet)\b[\s\S]*?<\/\1\s*>/gi,
			count("blockedTags")
		)
		.replace(/<\/?(?:iframe|object|embed|frame|frameset|applet)\b[^>]*>/gi, count("blockedTags"))
		.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, count("handlers"))
		.replace(
			/\s(?:href|xlink:href|action|formaction)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi,
			count("handlers")
		)
		.replace(
			/\s(?:src|poster|srcset)\s*=\s*(?:"\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*')/gi,
			count("externalResources")
		)
		.replace(/@import\b[^;{}]*;?/gi, count("externalResources"))
		.replace(/url\(\s*(["']?)\s*(?:https?:)?\/\/[^)]*\)/gi, () => {
			report.externalResources++;
			return "none";
		});
	return { html: out.trim(), report };
}

const DATA_THEME = /\sdata-theme\s*=\s*["']([\w -]+)["']/i;

const KEY_VALUE = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;
const MAX_TITLE = 120;

function unquote(value: string): string {
	const v = value.trim();
	if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
		return v.slice(1, -1);
	}
	return v;
}

/** Slides in reveal's Markdown: the body split on lines of exactly `---`. */
export function countSlides(body: string): number {
	const parts = body.split(/\r?\n---[ \t]*\r?\n/).filter((p) => p.trim() !== "");
	return Math.max(1, parts.length);
}

export function parseDeck(source: string): ParsedDeck {
	const text = source.replace(/^\u{FEFF}/u, "").replace(/\r\n?/g, "\n");
	const meta: DeckMeta = {};
	let body = text;

	const lines = text.split("\n");
	let first = 0;
	while (first < lines.length && lines[first].trim() === "") first++;
	if (lines[first]?.trim() === "---") {
		let close = -1;
		for (let i = first + 1; i < lines.length; i++) {
			if (lines[i].trim() === "---") {
				close = i;
				break;
			}
		}
		if (close !== -1) {
			const block = lines.slice(first + 1, close).filter((l) => l.trim() !== "");
			// Only a block made of key: value lines is front matter; anything else is slides
			if (block.length > 0 && block.every((l) => KEY_VALUE.test(l))) {
				for (const line of block) {
					const kv = KEY_VALUE.exec(line);
					if (!kv) continue;
					const [, key, raw] = kv;
					const value = unquote(raw);
					switch (key.toLowerCase()) {
						case "title":
							if (value) meta.title = value.slice(0, MAX_TITLE);
							break;
						case "theme": {
							const v = sanitizeTheme(value);
							if (v) meta.theme = v;
							break;
						}
						case "accent": {
							const v = sanitizeAccent(value);
							if (v) meta.accent = v;
							break;
						}
						case "font": {
							const v = sanitizeFont(value);
							if (v) meta.font = v;
							break;
						}
						case "logo": {
							const v = sanitizeLogo(value);
							if (v) meta.logo = v;
							break;
						}
					}
				}
				body = lines.slice(close + 1).join("\n");
			}
		}
	}
	// A deck that opens with a bare separator would start with an empty slide
	body = body.replace(/^\s*---[ \t]*\n/, "").replace(/^\n+/, "");
	if (/<section[\s>]/i.test(body)) {
		// `data-theme="dracula"` on a section names a theme, like the front matter does
		const named = sanitizeTheme(DATA_THEME.exec(body)?.[1]);
		if (named && !meta.theme) meta.theme = named;
		const cleaned = sanitizeHtmlDeck(body);
		const slideCount = Math.max(1, (cleaned.html.match(/<section[\s>]/gi) ?? []).length);
		return { meta, mode: "html", body: cleaned.html, stripped: cleaned.report, slideCount };
	}
	return { meta, mode: "markdown", body, stripped: { ...NO_STRIP }, slideCount: countSlides(body) };
}

/** A name for the downloaded file and the PDF: the first heading, else the title, else "slides". */
export function deckTitle(parsed: ParsedDeck, fallback = "slides"): string {
	if (parsed.meta.title) return parsed.meta.title;
	if (parsed.mode === "html") {
		const h = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/i.exec(parsed.body);
		const text = h
			? h[1]
					.replace(/<[^>]*>/g, " ")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, MAX_TITLE)
			: "";
		return text || fallback;
	}
	const heading = /^#{1,3}\s+(.+)$/m.exec(parsed.body);
	return heading
		? heading[1].replace(/[*_`]/g, "").trim().slice(0, MAX_TITLE) || fallback
		: fallback;
}

const FENCE = /^```([\w+#.-]*)[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm;

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Replace fenced code blocks by pre-highlighted `<pre><code>` HTML. The deck
 * is highlighted here, in the app, with the same highlighter as chat: the
 * preview sandbox then needs no highlighter of its own (a bundled
 * highlight.js with every language is nearly a megabyte). A line that is
 * exactly `---` inside code is wrapped so reveal's slide splitter, which
 * works on the raw text, does not cut the block in two.
 */
export function highlightFences(
	body: string,
	highlight: (code: string, lang?: string) => string
): string {
	return body.replace(FENCE, (_all, lang: string, code: string) => {
		const html = lang ? highlight(code, lang.toLowerCase()) : escapeHtml(code);
		const safe = html.replace(/^---[ \t]*$/gm, "<span>---</span>");
		const cls = lang ? ` language-${lang.toLowerCase().replace(/[^\w+#.-]/g, "")}` : "";
		return `<pre><code class="hljs${cls}">${safe}</code></pre>`;
	});
}
