import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";
import { canonicalUrl } from "./fetchUrlUtils";
import { equivalentUrls } from "./fetchEquivalence";

/**
 * The "auto-fetch with verification" web-fetch policy
 * (`Settings.webFetchPolicy === "auto-verified"`): when the model asks for a
 * URL neither the user nor `web_search` supplied, the harness — never the
 * model — runs one search and fetches only if the URL is actually backed by
 * what came back. The model never sees this happen; it just gets the page or
 * a refusal.
 *
 * A "match" is either the requested URL itself appearing in fresh results, or
 * one of its reviewed equivalents (`fetchEquivalence.ts`) doing so — the one
 * discretion this policy grants, and it is table-driven, not model-driven.
 * Exactly one search is attempted per fetch; there is no retry loop.
 */

export interface VerifiedFetchOk {
	matched: true;
}

export interface VerifiedFetchRefusal {
	matched: false;
	/** Evidence for the refusal the model reads: what was searched, what came back, and why it didn't count. */
	evidence: string;
}

interface SearchResultLike {
	url: unknown;
}

function canonicalSet(urls: unknown[]): Set<string> {
	const out = new Set<string>();
	for (const value of urls) {
		if (typeof value !== "string") continue;
		const canonical = canonicalUrl(value);
		if (canonical) out.add(canonical);
	}
	return out;
}

/** True if `requested` or one of its reviewed equivalents is present in `found`. */
function isVerified(requested: string, found: Set<string>): boolean {
	if (found.has(requested)) return true;
	return equivalentUrls(requested).some((candidate) => {
		const canonical = canonicalUrl(candidate);
		return canonical !== null && found.has(canonical);
	});
}

export async function verifyUrlBySearch({
	url,
	token,
}: {
	url: string;
	token: string;
}): Promise<VerifiedFetchOk | VerifiedFetchRefusal> {
	// The URL itself is the query: this looks for the page being indexed, not
	// for topical matches, which is a materially different (and weaker) check.
	const query = url;
	let results: { title?: unknown; url?: unknown }[];
	try {
		const answer = await gateway.post<{ results?: SearchResultLike[] }>(token, "search", {
			query,
			max_results: 5,
		});
		results = Array.isArray(answer.results) ? answer.results : [];
	} catch (err) {
		const message = err instanceof GatewayCallFailed ? err.message : "the search backend failed";
		return {
			matched: false,
			evidence: `Searched for: ${query}\nThe search could not run (${message}), so the URL could not be verified.`,
		};
	}

	const resultUrls = results
		.map((r) => (typeof r.url === "string" ? r.url : null))
		.filter((u): u is string => u !== null);
	const found = canonicalSet(resultUrls);

	if (isVerified(url, found)) return { matched: true };

	const shown = resultUrls.length > 0 ? resultUrls.slice(0, 5).join("\n") : "(no results)";
	return {
		matched: false,
		evidence:
			`Searched for: ${query}\nResults:\n${shown}\n\n` +
			"None of these results named the requested URL (or a recognized equivalent of it).",
	};
}
