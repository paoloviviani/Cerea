/**
 * Main-content extraction for HTML the direct backend fetched.
 *
 * The playwright backend runs Readability inside the page's own browser DOM.
 * The direct backend has no browser, so the same extractor runs here against a
 * server-side DOM (linkedom, a small pure-JS one). Without this a direct fetch
 * keeps the page's navigation, headers and footers, which eat the read budget.
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { logger } from "$lib/server/logger";

/** Readability on a very large page costs more than the trimming is worth. */
const MAX_HTML_CHARS = 3_000_000;

export interface Article {
	title: string | null;
	/** The article as HTML, for the caller to turn into text. */
	content: string;
}

/** The page's main content, or null (not an article, too large, or unparseable): a normal outcome, not a failure. */
export function extractArticle(html: string, url: string): Article | null {
	if (html.length > MAX_HTML_CHARS) return null;
	try {
		const { document } = parseHTML(html);
		// Readability resolves relative links against the document's URL.
		Object.defineProperty(document, "baseURI", { value: url, configurable: true });
		// linkedom's Document is not typed as the DOM one Readability expects; it implements what it reads.
		const article = new Readability(document as unknown as Document).parse();
		if (!article?.content?.trim()) return null;
		return { title: article.title?.trim() || null, content: article.content };
	} catch (err) {
		logger.warn({ err, url }, "direct_readability_failed");
		return null;
	}
}
