/**
 * A plain HTTPS GET, through the SSRF guard.
 *
 * What this app has always done, kept as the default because it needs no extra
 * service and changing behaviour for existing deployments on upgrade would be
 * the wrong way round. Its weakness is the reason the other backends exist: a
 * page built by JavaScript arrives as an empty shell, with a 200 and nothing
 * to say the content was never there.
 *
 * The body is read as bytes (`./bytes`) so a PDF or Office file comes back as
 * a document to extract, not as text. An HTML page is reduced to its main
 * content (`./readable`); when that finds none, the whole page is returned and
 * the caller strips the markup.
 */

import type { FetchedPage } from "./index";
import { fetchBytes, pageFromBytes } from "./bytes";
import { extractArticle } from "./readable";

export async function fetchDirect(url: string): Promise<FetchedPage> {
	return (await fetchDirectDetailed(url)).page;
}

/**
 * The page as `fetchDirect` returns it, and the page as delivered, for a caller
 * (fetch-first) that must judge the whole page and not only the part Readability
 * kept: a homepage is a list of headlines, which Readability may cut to a
 * fragment or to nothing.
 */
export async function fetchDirectDetailed(
	url: string
): Promise<{ page: FetchedPage; raw: FetchedPage }> {
	const raw = await pageFromBytes(await fetchBytes(url), "direct");
	if (raw.document || !/html/i.test(raw.contentType)) return { page: raw, raw };
	const article = extractArticle(raw.content, raw.url);
	const page = article
		? { ...raw, title: article.title ?? raw.title, content: article.content, extracted: true }
		: raw;
	return { page, raw };
}
