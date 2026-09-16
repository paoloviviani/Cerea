/**
 * Keyless web search through DuckDuckGo's HTML endpoint, as the zero-config
 * fallback for the gateway's unified search.
 *
 * Endpoint choice, verified live 2026-09-16: the Instant Answer API
 * (`api.duckduckgo.com/?q=…&format=json`) answers 200 with a well-formed body
 * whose `Abstract`, `Answer`, `Results` and `RelatedTopics` are all empty for
 * ordinary web queries ("European cloud providers", "Python asyncio gather",
 * "Eiffel Tower height" — only rare entity-head queries carry an abstract).
 * It is an answers API, not a search API, so it cannot back a results list.
 * The HTML endpoint (`html.duckduckgo.com/html/`, form-POSTed `q`) is the
 * lightest working alternative, parsed minimally below.
 *
 * Two operational caveats, both structural rather than bugs in this file:
 *
 * - DuckDuckGo serves automation detection (`anomaly-modal`, "bots use
 *   DuckDuckGo too") instead of results to flagged source IPs. A blocked call
 *   returns `blocked: true` rather than throwing, so the caller can say so
 *   instead of failing the turn.
 * - Queries leave the deployment: the query text (and the server's IP) goes
 *   to DuckDuckGo, a US company, with no key and no account. An operator who
 *   cannot accept that sets `DDG_SEARCH_DISABLED=true`.
 *
 * Egress discipline for the shared box: one POST per search, an 8s timeout,
 * and every inbound and outbound size capped.
 */

export interface DuckDuckGoHit {
	title: string;
	url: string;
	snippet: string;
}

export interface DuckDuckGoOutcome {
	hits: DuckDuckGoHit[];
	/** The endpoint answered a bot challenge instead of results. */
	blocked: boolean;
}

export const DUCKDUCKGO_ENDPOINT = "https://html.duckduckgo.com/html/";
export const DUCKDUCKGO_TIMEOUT_MS = 8_000;
/** Bound the buffered page; a results page is tens of KB, a challenge ~14KB. */
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_SNIPPET_CHARS = 500;

// A desktop UA: without one the endpoint answers a different (or no) page.
const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function decodeEntities(value: string): string {
	return value
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16))
		)
		.replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)));
}

function cleanText(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The result link out of a `result__a` anchor href. DDG wraps the target in
 * a `/l/?uddg=<urlencoded-target>` redirect; a bare absolute URL (or a
 * protocol-relative one) is used as-is. Anything else is not a result.
 */
function targetUrl(href: string): string | null {
	const unescaped = href.replace(/&amp;/gi, "&");
	const redirect = unescaped.match(/[?&]uddg=([^&]+)/);
	try {
		if (redirect) {
			const url = new URL(decodeURIComponent(redirect[1]));
			return url.protocol === "https:" ? url.href : null;
		}
		const url = new URL(unescaped, "https://duckduckgo.com");
		return url.protocol === "https:" && url.hostname !== "duckduckgo.com" ? url.href : null;
	} catch {
		return null;
	}
}

/**
 * Minimal parse of the HTML results page: every `result__a` anchor in order,
 * each paired with the first `result__snippet` anchor that follows it before
 * the next result. Tolerant by design — DDG restyles this page — so an
 * unparseable page yields no hits rather than an exception.
 */
export function parseDuckDuckGoResults(html: string, maxResults: number): DuckDuckGoHit[] {
	const max = Math.min(10, Math.max(1, maxResults));
	const anchorPattern = /<a\b[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const anchors: { href: string; title: string; index: number }[] = [];
	let match: RegExpExecArray | null;
	while ((match = anchorPattern.exec(html)) !== null) {
		anchors.push({ href: match[1], title: cleanText(match[2]), index: match.index });
	}
	const snippetPattern = /<a\b[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippets: { text: string; index: number }[] = [];
	while ((match = snippetPattern.exec(html)) !== null) {
		snippets.push({ text: cleanText(match[1]), index: match.index });
	}
	const hits: DuckDuckGoHit[] = [];
	for (let i = 0; i < anchors.length && hits.length < max; i++) {
		const url = targetUrl(anchors[i].href);
		if (!url) continue;
		const nextResult = i + 1 < anchors.length ? anchors[i + 1].index : Number.POSITIVE_INFINITY;
		const snippet = snippets.find((s) => s.index > anchors[i].index && s.index < nextResult);
		hits.push({
			title: anchors[i].title || "untitled",
			url,
			snippet: (snippet?.text ?? "").slice(0, MAX_SNIPPET_CHARS),
		});
	}
	return hits;
}

export function isDuckDuckGoChallenge(html: string): boolean {
	return html.includes("anomaly-modal") || html.includes("challenge-form");
}

/**
 * One keyless search. Throws on transport failure or a non-2xx answer; a 200
 * that carries no parseable results (or a bot challenge) is data, not an
 * error, and comes back as hits/blocked for the caller to render.
 */
export async function searchDuckDuckGo(
	query: string,
	maxResults: number,
	fetchFn: typeof fetch = fetch
): Promise<DuckDuckGoOutcome> {
	const max = Math.min(10, Math.max(1, maxResults));
	const body = new URLSearchParams({ q: query }).toString();
	const response = await fetchFn(DUCKDUCKGO_ENDPOINT, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "text/html",
			"accept-language": "en",
			"user-agent": USER_AGENT,
		},
		body,
		signal: AbortSignal.timeout(DUCKDUCKGO_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`DuckDuckGo answered ${response.status}.`);
	}
	const html = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
	if (isDuckDuckGoChallenge(html)) return { hits: [], blocked: true };
	return { hits: parseDuckDuckGoResults(html, max), blocked: false };
}
