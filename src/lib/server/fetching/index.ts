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
}

/** The configured backend, defaulting to what this app has always done. */
export function configuredBackend(): FetchBackend {
	const raw = (config.FETCH_BACKEND ?? "").trim();
	return (FETCH_BACKENDS as readonly string[]).includes(raw) ? (raw as FetchBackend) : "direct";
}

export class FetchBackendUnavailable extends Error {}

export async function fetchPage(url: string): Promise<FetchedPage> {
	const backend = configuredBackend();
	switch (backend) {
		case "playwright": {
			const { renderWithPlaywright } = await import("./playwright");
			return renderWithPlaywright(url);
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
