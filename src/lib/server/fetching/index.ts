/**
 * Fetching a URL somebody named.
 *
 * **This is not search.** Given a plain URL you do not search for it, you fetch
 * it — and the two have different costs, different failure modes and different
 * backends. Keeping them apart is why this module exists rather than being a
 * branch inside a search path.
 *
 * Three backends, chosen site-wide by an administrator:
 *
 * - `direct` — a plain HTTPS GET through the SSRF guard. What this app has
 *   always done, and still the default: it is the only one with no extra
 *   service behind it, and changing behaviour for existing deployments on
 *   upgrade would be the wrong way round.
 * - `playwright` — the renderer in this deployment
 *   (the `fetch` profile of the stack, the deploy kit's `compose.yaml`). Needed because a growing
 *   share of the web is an empty `<div>` to an HTTP client, returned with a 200
 *   and no error to say the page was never built.
 * - `pystino` — the gateway renders it. **Stubbed**: the surface does not exist
 *   yet and this refuses with a readable message rather than pretending.
 *
 * The choice is the chat's to make, not the gateway's, for the same reason ADR
 * 0062 put the knowledge pipeline in this admin console: what the composer's
 * URL button does is a product decision.
 */

import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";

export const FETCH_BACKENDS = ["direct", "playwright", "pystino"] as const;
export type FetchBackend = (typeof FETCH_BACKENDS)[number];

export interface FetchedPage {
	/** Final URL after redirects. */
	url: string;
	title: string | null;
	/** The page as text a model can read. */
	content: string;
	contentType: string;
	/** Which backend produced this, for the caller to log or show. */
	backend: FetchBackend;
	/**
	 * Whether `content` is a main-content extraction rather than the page
	 * (or response body) as delivered. `false` for every backend that does not
	 * attempt extraction — that is not a failure, just a thing that was never
	 * tried.
	 */
	extracted: boolean;
	/**
	 * Set instead of `content` when the URL is a document (PDF, Word, Excel,
	 * PowerPoint, epub) rather than a page. The caller extracts it with
	 * `extractDocument`, the reader an attached file uses.
	 */
	document?: { bytes: ArrayBuffer; mime: string; filename: string };
}

/** The configured backend, defaulting to what this app has always done. */
export function configuredBackend(): FetchBackend {
	const raw = (config.FETCH_BACKEND ?? "").trim();
	return (FETCH_BACKENDS as readonly string[]).includes(raw) ? (raw as FetchBackend) : "direct";
}

export class FetchBackendUnavailable extends Error {}

export interface FetchOptions {
	/**
	 * Skip the direct attempt and read the page in the browser. Only means
	 * something with the `playwright` backend; the other backends ignore it.
	 */
	render?: boolean;
}

/**
 * With `playwright`, a page is read directly first, through the same SSRF guard
 * and document handling, and the browser is the fallback: it costs a browser
 * context and seconds, and most pages do not need it. The direct result is used
 * when it is a real page (`looksLikeRealPage`: enough readable text, not a
 * consent notice, not an empty JavaScript shell); otherwise, and when the
 * direct fetch fails outright (a 403 bot wall, a timeout), the page is rendered.
 * `FetchedPage.backend` says which produced the result.
 */
async function fetchDirectFirst(url: string): Promise<FetchedPage> {
	const { fetchDirectDetailed } = await import("./direct");
	const { renderWithPlaywright } = await import("./playwright");
	const { looksLikeRealPage } = await import("./pageQuality");
	const { readablePageText } = await import("./readable");
	let direct: FetchedPage | null = null;
	try {
		const { page, raw } = await fetchDirectDetailed(url);
		direct = page;
		const isHtml = !page.document && /html/i.test(page.contentType);
		// A document, or text that is not a page (JSON, plain text), has nothing a browser would add.
		if (!isHtml) return page;
		// Judge the whole page's readable text, not only Readability's article: a
		// homepage is a list of headlines, yet is a real page.
		const full = readablePageText(raw.content);
		if (looksLikeRealPage(full, raw.url, raw.content)) {
			// Readability keeping only a fragment of a text-rich page (a list of
			// headlines has no article) would hand the model a fragment of it.
			if (page.extracted && readablePageText(page.content).length < full.length * 0.3) {
				return raw;
			}
			return page;
		}
		logger.debug({ url }, "fetch_direct_thin_rendering");
	} catch (err) {
		logger.debug({ url, err: String(err) }, "fetch_direct_failed_rendering");
	}
	try {
		return await renderWithPlaywright(url);
	} catch (err) {
		// A thin direct page beats no answer when the renderer is down.
		if (direct) {
			logger.warn({ url, err: String(err) }, "fetch_render_failed_using_direct");
			return direct;
		}
		throw err;
	}
}

export async function fetchPage(url: string, options: FetchOptions = {}): Promise<FetchedPage> {
	const backend = configuredBackend();
	switch (backend) {
		case "playwright": {
			if (options.render) {
				const { renderWithPlaywright } = await import("./playwright");
				return renderWithPlaywright(url);
			}
			return fetchDirectFirst(url);
		}
		case "pystino": {
			// Deliberately not a silent fall back to `direct`. An administrator
			// who selected this asked for a specific thing; quietly doing
			// something else would look like it worked and produce the empty-div
			// answer they were trying to avoid.
			logger.warn({ url }, "fetch_backend_pystino_not_implemented");
			throw new FetchBackendUnavailable(
				"The Pystino fetch endpoint is selected but not implemented yet. " +
					"Choose the local renderer or direct fetching in Administration → Fetching."
			);
		}
		default: {
			const { fetchDirect } = await import("./direct");
			return fetchDirect(url);
		}
	}
}
