import DOMPurify from "isomorphic-dompurify";
import { symbolFontKind, mapSymbolText } from "./docxGlyphs";
import { FONT_STYLES, PREVIEW_FONT_FAMILIES, familyFor, type PreviewFamily } from "./officeFonts";

/**
 * The docx preview pipeline shared by FileArtifactView (artifact panel) and
 * FileCard (side pane): docx-preview offscreen, then DOMPurify. A sibling of
 * $lib/utils/filePreview rather than a part of it — that module is imported
 * widely and must stay DOM-free, and a sibling keeps docx-preview and DOMPurify
 * out of the bundles of conversations without a docx in them.
 */

/**
 * Sanitize a docx-preview rendering. FORCE_BODY is load-bearing, not cosmetic:
 * docx-preview emits its <style> elements at the START of the container (its
 * renderAsync routes style nodes to a styleContainer that defaults to the body
 * container itself), and DOMPurify's default parsing puts a fragment that
 * begins with <style> into <head> — head content a body-fragment sanitizer
 * drops. That is how every font, size, paragraph style, list numbering and
 * table border silently vanished from the preview while the text survived.
 * Parsing the fragment as body content keeps the style block; ADD_TAGS pins
 * "style" in the allowlist beside it. Nothing else is loosened — the sandboxed
 * frame and the preview CSP stay the boundary, as for every preview.
 */
export function sanitizeDocxHtml(html: string): string {
	return DOMPurify.sanitize(html, { FORCE_BODY: true, ADD_TAGS: ["style"] });
}

export interface DocxPreviewOptions {
	/** Where static/fonts/office is served from; without it fonts are left as the document names them. */
	fontBase?: string;
	/** Fetches one font file; replaceable in tests. */
	fetchFont?: (url: string) => Promise<ArrayBuffer>;
}

const SYMBOL_DECL = /font-family\s*:\s*("[^"]*"|'[^']*'|[^;}"']*)\s*;?/gi;

/**
 * Replace Symbol/Wingdings private-use glyphs (bullets above all) with their
 * Unicode equivalents, in docx-preview's generated CSS (`p.docx-num-1-0:before
 * { content: "\f0b7"; font-family: Symbol }`) and in inline runs. The font
 * declaration goes with them, so the glyph comes from a font the browser has.
 * A rule or run whose text holds no private-use character is left alone —
 * Symbol's ordinary letters still need the font they were typed in.
 */
export function fixSymbolGlyphs(root: HTMLElement): void {
	for (const style of root.querySelectorAll("style")) {
		style.textContent = (style.textContent ?? "").replace(/\{[^{}]*\}/g, (body) => {
			let kind: "symbol" | "wingdings" | null = null;
			for (const m of body.matchAll(SYMBOL_DECL)) kind = kind ?? symbolFontKind(m[1].split(",")[0]);
			if (!kind) return body;
			const mapped = mapSymbolText(body, kind, true);
			return mapped.changed ? mapped.text.replace(SYMBOL_DECL, "") : body;
		});
	}
	for (const el of root.querySelectorAll<HTMLElement>("[style]")) {
		const family = el.style.fontFamily;
		const kind = family ? symbolFontKind(family.split(",")[0]) : null;
		if (!kind) continue;
		const walker = window.document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		let changed = false;
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const mapped = mapSymbolText(n.nodeValue ?? "", kind);
			if (mapped.changed) {
				n.nodeValue = mapped.text;
				changed = true;
			}
		}
		if (changed) el.style.removeProperty("font-family");
	}
}

function rewriteFamilyList(value: string, used: Set<PreviewFamily>): string {
	const items = value.split(",").map((i) => i.trim());
	const out: string[] = [];
	for (const item of items) {
		const family = familyFor(item.replace(/^["']|["']$/g, ""));
		if (family) {
			used.add(family);
			if (!out.includes(`"${family}"`)) out.push(`"${family}"`);
		}
		out.push(item);
	}
	return out.join(", ");
}

/**
 * Put the metric-compatible open font first in every font-family list that
 * names an Office font it replaces (Calibri -> Carlito, Arial -> Liberation
 * Sans, ...), in the generated CSS and in inline styles. The Office name stays
 * after it, so a font that fails to load falls back as before. Returns the
 * families the document ended up using.
 */
export function rewriteFontFamilies(root: HTMLElement): Set<PreviewFamily> {
	const used = new Set<PreviewFamily>();
	// Theme fonts reach the CSS as custom properties (--docx-minorHAnsi-font),
	// which the generated rules read with var(), so they are rewritten too.
	const decl = /((?:font-family|--docx-[\w-]+-font)\s*:\s*)([^;}]+)/gi;
	for (const style of root.querySelectorAll("style")) {
		style.textContent = (style.textContent ?? "").replace(
			decl,
			(_m, head: string, value: string) => head + rewriteFamilyList(value, used)
		);
	}
	for (const el of root.querySelectorAll<HTMLElement>("[style]")) {
		const value = el.style.fontFamily;
		if (value) el.style.fontFamily = rewriteFamilyList(value, used);
	}
	return used;
}

/** Which style files the document needs: regular always, the rest only when it uses them. */
export function wantedStyles(html: string): Set<(typeof FONT_STYLES)[number]> {
	const bold = /font-weight\s*:\s*(bold|[6-9]00)|<(b|strong)[\s>]/i.test(html);
	const italic = /font-style\s*:\s*italic|<(i|em)[\s>]/i.test(html);
	const styles = new Set<(typeof FONT_STYLES)[number]>(["Regular"]);
	if (bold) styles.add("Bold");
	if (italic) styles.add("Italic");
	if (bold && italic) styles.add("BoldItalic");
	return styles;
}

const fontCache = new Map<string, Promise<string>>();

async function fontDataUrl(
	url: string,
	fetchFont: (url: string) => Promise<ArrayBuffer>
): Promise<string> {
	let hit = fontCache.get(url);
	if (!hit) {
		hit = fetchFont(url).then((buf) => {
			const bytes = new Uint8Array(buf);
			let binary = "";
			for (let i = 0; i < bytes.length; i += 0x8000) {
				binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			}
			return `data:font/ttf;base64,${btoa(binary)}`;
		});
		fontCache.set(url, hit);
		// A failed fetch is not remembered: the next preview may succeed.
		hit.catch(() => fontCache.delete(url));
	}
	return hit;
}

/**
 * `@font-face` rules for the families a document uses, with `data:` sources
 * (the preview CSP allows fonts from nothing else). Only the needed files are
 * fetched; one that cannot be is skipped, which is a plainer rendering.
 */
export async function buildFontFaceCss(
	families: Set<PreviewFamily>,
	styles: Set<(typeof FONT_STYLES)[number]>,
	options: { fontBase: string; fetchFont?: (url: string) => Promise<ArrayBuffer> }
): Promise<string> {
	const fetchFont =
		options.fetchFont ??
		(async (url: string) => {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`font ${url}: ${res.status}`);
			return res.arrayBuffer();
		});
	const rules = await Promise.all(
		[...families].flatMap((family) =>
			[...styles].map(async (style) => {
				try {
					const url = `${options.fontBase}/${PREVIEW_FONT_FAMILIES[family]}-${style}.ttf`;
					const data = await fontDataUrl(url, fetchFont);
					const weight = style.startsWith("Bold") ? "bold" : "normal";
					const slant = style.endsWith("Italic") ? "italic" : "normal";
					return `@font-face{font-family:"${family}";font-weight:${weight};font-style:${slant};src:url(${data}) format("truetype");}`;
				} catch {
					return "";
				}
			})
		)
	);
	return rules.join("");
}

/**
 * Render a Word document's bytes to sanitized HTML through docx-preview,
 * offscreen in a detached container — the renderer writes into a live element,
 * so its DOM is a means, not the destination.
 *
 * Size caps stay at the call sites: each one already checks before importing
 * the library, against the bytes it actually holds.
 */
export async function renderDocxPreview(
	bytes: Uint8Array,
	options: DocxPreviewOptions = {}
): Promise<string> {
	// Dynamic import: the renderer must never enter the bundle of a
	// conversation without a docx in it.
	const { renderAsync } = await import("docx-preview");
	// slice() copies exactly the viewed range (bytes.buffer may overhang it,
	// transferable slices), and a Blob rather than a bare buffer because
	// docx-preview's jszip layer reads it through the File API.
	const blob = new Blob([bytes.slice()], {
		type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	});
	const container = window.document.createElement("div");
	await renderAsync(blob, container, undefined, {
		// The docx carries its own fonts, sizes and page geometry —
		// rendering those is the point of the swap; the previous
		// converter emitted a bare semantic fragment that had to be
		// styled by hand instead.
		inWrapper: true,
		ignoreWidth: false,
		ignoreHeight: false,
		ignoreFonts: false,
		breakPages: true,
		// Headers, footers, footnotes and endnotes are part of the page's
		// real layout — and docx-preview 0.4.x renders them by default, so
		// the earlier off-by-name posture was turning the library's own
		// default off. Changes and comments stay off: review markup is not
		// document content.
		renderHeaders: true,
		renderFooters: true,
		renderFootnotes: true,
		renderEndnotes: true,
		renderChanges: false,
		renderComments: false,
		// Images inline as data: URLs — the preview CSP allows exactly
		// data:/blob: for img-src, and this keeps the document self-contained
		useBase64URL: true,
	});
	// Checked before sanitizing: an empty render is a rendering problem worth
	// its own message, not a sanitizing one.
	if (!container.innerHTML.trim()) {
		throw new Error("the document rendered empty — download it to read the whole file");
	}
	fixSymbolGlyphs(container);
	const families = rewriteFontFamilies(container);
	const html = sanitizeDocxHtml(container.innerHTML);
	if (families.size === 0 || options.fontBase === undefined) return html;
	// The @font-face block is built here from our own files and prepended
	// after sanitizing, so DOMPurify never has to pass a multi-megabyte data: URL.
	const css = await buildFontFaceCss(families, wantedStyles(html), {
		fontBase: options.fontBase,
		fetchFont: options.fetchFont,
	});
	return css ? `<style>${css}</style>${html}` : html;
}
