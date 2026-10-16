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
	const page = await pageFromBytes(await fetchBytes(url), "direct");
	if (page.document || !/html/i.test(page.contentType)) return page;
	const article = extractArticle(page.content, page.url);
	return article
		? { ...page, title: article.title ?? page.title, content: article.content, extracted: true }
		: page;
}
