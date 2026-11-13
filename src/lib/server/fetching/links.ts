/**
 * The page's main links, for `web_fetch`: text without links leaves a model that needs one
 * article's address to guess it or search for it. Bounded, deduplicated, navigation and
 * boilerplate skipped where that is cheap to see.
 */

import { parseHTML } from "linkedom";
import { logger } from "$lib/server/logger";
import { sanitizeText } from "$lib/server/browser/sanitize";

export interface PageLink {
	text: string;
	url: string;
}

export const MAX_LINKS = 40;
export const MAX_LINKS_BYTES = 4_096;
const MAX_LINK_TEXT = 100;
/** A longer address is a tracking or session link, not a destination to read out. */
const MAX_URL_CHARS = 300;
/** Bidirectional controls and zero-width characters: they reorder or hide text. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad]/g;
const MAX_HTML_CHARS = 3_000_000;

/** Elements whose links are navigation or page furniture, never the content. */
const CHROME_SELECTOR =
	"script, style, noscript, template, svg, nav, footer, aside, form, header nav, " +
	'[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [aria-hidden="true"], ' +
	// Links a reader cannot see are for crawlers (and for text meant for a model).
	'[hidden], [inert], [style*="display:none" i], [style*="display: none" i], ' +
	'[style*="visibility:hidden" i], [style*="visibility: hidden" i]';
/** A class or id that names furniture. */
const CHROME_NAME =
	/(^|[\s_-])(nav|navbar|menu|footer|cookie|consent|breadcrumbs?|sidebar|social|share|skip)($|[\s_-])/i;
/** Link text that is a control, not a destination. */
const BOILERPLATE_TEXT =
	/^(skip to .*|log ?in|sign ?(in|up)|subscribe|register|menu|search|privacy( policy)?|terms( of (use|service))?|cookies?( settings| policy)?|contact( us)?|about( us)?|help|accessibility|advertise|careers|rss|home|read more|more|share|close)$/i;

/** The absolute http(s) address of an href, without its fragment, or null. */
function resolve(href: string, base: string): string | null {
	const raw = href.trim();
	if (!raw || raw.startsWith("#")) return null;
	if (/^(javascript|mailto|tel|data|sms|blob|about):/i.test(raw)) return null;
	try {
		const url = new URL(raw, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url.toString();
	} catch {
		return null;
	}
}

function isChrome(el: Element): boolean {
	const name = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;
	return name.trim() !== "" && CHROME_NAME.test(name);
}

/** The page's main links in document order: link text and absolute URL, at most `MAX_LINKS`. */
export function extractMainLinks(html: string, baseUrl: string): PageLink[] {
	if (!html || html.length > MAX_HTML_CHARS) return [];
	try {
		const { document } = parseHTML(html);
		// A page's <base href> is where its relative links point.
		const baseHref = document.querySelector("base[href]")?.getAttribute("href");
		const base = (baseHref && resolve(baseHref, baseUrl)) || baseUrl;
		for (const el of [...document.querySelectorAll(CHROME_SELECTOR)]) el.remove();
		for (const el of [...document.querySelectorAll("[class], [id]")]) {
			if (isChrome(el)) el.remove();
		}
		const root = document.querySelector("main, article, [role=main]") ?? document;
		const collect = (scope: ParentNode): PageLink[] => {
			const seen = new Set<string>();
			const links: PageLink[] = [];
			for (const a of scope.querySelectorAll("a[href]")) {
				const url = resolve(a.getAttribute("href") ?? "", base);
				if (!url || url.length > MAX_URL_CHARS || seen.has(url)) continue;
				const text = sanitizeText((a.textContent ?? "").replace(INVISIBLE, "")).trim();
				// Text that is itself an address can pass a different one off as the destination.
				if (text.length < 2 || text.includes("://") || BOILERPLATE_TEXT.test(text)) continue;
				seen.add(url);
				links.push({
					text: text.length > MAX_LINK_TEXT ? `${text.slice(0, MAX_LINK_TEXT - 1)}…` : text,
					url,
				});
			}
			return links;
		};
		let links = collect(root);
		// A page whose <main> holds almost nothing links from elsewhere.
		if (links.length < 3 && root !== document) links = collect(document);
		return links;
	} catch (err) {
		logger.warn({ err, url: baseUrl }, "page_links_failed");
		return [];
	}
}

/** The labelled block placed after the page text, within the count and byte caps; "" when empty. */
export function formatLinks(links: PageLink[]): string {
	if (links.length === 0) return "";
	const header = "Main links on this page, as text: address";
	const lines: string[] = [];
	// The header, its count suffix (" (40 of 200)") and colon are inside the cap too.
	let bytes = Buffer.byteLength(header) + 20;
	for (const link of links) {
		if (lines.length >= MAX_LINKS) break;
		const line = `- ${link.text}: ${link.url}`;
		const size = Buffer.byteLength(line) + 1;
		if (bytes + size > MAX_LINKS_BYTES) continue;
		bytes += size;
		lines.push(line);
	}
	if (lines.length === 0) return "";
	const more = links.length > lines.length ? ` (${lines.length} of ${links.length})` : "";
	return `${header}${more}:\n${lines.join("\n")}`;
}
