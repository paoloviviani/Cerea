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
 * a document to extract, not as text.
 */

import type { FetchedPage } from "./index";
import { fetchBytes, pageFromBytes } from "./bytes";

export async function fetchDirect(url: string): Promise<FetchedPage> {
	return pageFromBytes(await fetchBytes(url), "direct");
}
