/**
 * A plain HTTPS GET, through the SSRF guard.
 *
 * What this app has always done, kept as the default because it needs no extra
 * service and changing behaviour for existing deployments on upgrade would be
 * the wrong way round. Its weakness is the reason the other backends exist: a
 * page built by JavaScript arrives as an empty shell, with a 200 and nothing
 * to say the content was never there.
 */

import { ssrfSafeFetch, isValidUrl } from "$lib/server/urlSafety";
import type { FetchedPage } from "./index";

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 10 * 1024 * 1024;

export async function fetchDirect(url: string): Promise<FetchedPage> {
	if (!isValidUrl(url)) {
		throw new Error("Invalid or unsafe URL (only HTTPS is supported).");
	}

	const response = await ssrfSafeFetch(url, {
		headers: { "user-agent": "Cerea-Chat-Fetcher/1.0" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`That URL answered ${response.status}.`);
	}

	const contentType = response.headers.get("content-type") ?? "application/octet-stream";
	const body = await response.text();
	const content = body.length > MAX_BYTES ? body.slice(0, MAX_BYTES) : body;

	return {
		url: response.url || url,
		title: titleOf(content),
		content,
		contentType,
		backend: "direct",
	};
}

/** Cheap enough to be worth it, and the caller wants something to label the attachment with. */
function titleOf(html: string): string | null {
	const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
	return match ? match[1].trim().replace(/\s+/g, " ") || null : null;
}
