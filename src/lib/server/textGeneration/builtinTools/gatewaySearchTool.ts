import { config } from "$lib/server/config";
import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";
import { searchDuckDuckGo } from "./duckDuckGoSearch";
import type { BuiltinTool } from "./types";

/**
 * The gateway's unified search, as a builtin (`POST /v1/search`).
 *
 * One shape in, one shape out: the gateway picks the backend from the
 * caller's billing-group policy and translates both ways, always at the
 * vendor's default depth. The per-vendor adapters this file used to carry —
 * Linkup's `q`/`depth`, Exa's `query`/`type` — are deleted, not moved: a
 * caller that speaks the dialect chooses the backend, and choosing backends
 * is exactly what the group policy takes away from it.
 *
 * **Gated on a search grant** (`/v1/models ?include=search`), the same rule
 * the GitHub tools apply to `GITHUB_TOKEN`: a tool that is offered and always
 * fails costs the model a turn to discover that. The grant is the feature
 * switch and the permission in one. A group with no search policy answers
 * the unified route with a 404 naming the missing configuration, which
 * arrives here as a model-readable error, not an exception.
 *
 * **Keyless fallback.** When no backend is granted — or the gateway answers
 * the unified route with its no-provider 404 — the tool falls back to
 * DuckDuckGo (`./duckDuckGoSearch`), which needs no key and no gateway
 * policy. The fallback is on unless `DDG_SEARCH_DISABLED=true`, so a
 * deployment without a commercial search key still searches. The configured
 * path is untouched: a granted backend is always tried first, and every
 * other gateway failure stays a model-readable error exactly as before.
 */

export const WEB_SEARCH_TOOL_NAME = "web_search";

/** Whether the keyless DuckDuckGo fallback may run; on unless disabled. */
export function isDuckDuckGoEnabled(explicit?: boolean): boolean {
	return explicit ?? config.DDG_SEARCH_DISABLED !== "true";
}

/**
 * The search backends this caller may use, or none.
 *
 * Read from `/v1/models?include=search` with the caller's token: search
 * backends are absent from the default list (ADR 0071) — an
 * OpenAI-compatible client reading /v1/models would present one as a chat
 * model — and asking for them by name is the opt-in. The caller's grants
 * bound what comes back, so this is per-caller by construction. A gateway
 * that cannot be asked yields none — the turn loses the tool and keeps the
 * answer, the same direction every degradation in this pipeline takes.
 */
export async function findSearchModelIds(bearer: string): Promise<string[]> {
	const base = config.OPENAI_BASE_URL?.replace(/\/$/, "");
	if (!base) return [];
	try {
		const response = await fetch(`${base}/models?include=search`, {
			headers: { Authorization: `Bearer ${bearer}` },
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) return [];
		const json = (await response.json()) as {
			data?: { id?: unknown; kind?: unknown }[];
		};
		return (json.data ?? [])
			.filter(
				(entry): entry is { id: string; kind: string } =>
					typeof entry.id === "string" && typeof entry.kind === "string" && entry.kind === "search"
			)
			.map((entry) => entry.id);
	} catch {
		return [];
	}
}

export function createGatewaySearchBuiltins(params: {
	token?: string;
	/** The search backends this caller is granted, by name. */
	searchModelIds: string[];
	/** Search result URLs become safe fetch targets in a later tool round. */
	allowedFetchUrls?: Set<string>;
	/**
	 * Keyless DuckDuckGo fallback when no backend is granted (or the
	 * gateway reports none). Defaults to on unless `DDG_SEARCH_DISABLED=true`.
	 */
	duckDuckGoEnabled?: boolean;
}): BuiltinTool[] {
	const duckDuckGoEnabled = isDuckDuckGoEnabled(params.duckDuckGoEnabled);
	if (params.searchModelIds.length === 0 && !duckDuckGoEnabled) return [];
	return [
		{
			name: WEB_SEARCH_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: WEB_SEARCH_TOOL_NAME,
					description:
						"Search the web for current information: documentation, error messages, " +
						"recent releases, anything past the training data. Returns titles, links " +
						"and snippets.",
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description: "3-8 precise keywords, not a sentence.",
							},
							max_results: {
								type: "number",
								description: "1-10 results. Fewer is usually enough.",
							},
						},
						required: ["query"],
					},
				},
			},
			preprompt:
				`WEB SEARCH: ${WEB_SEARCH_TOOL_NAME} is how you reach the live web — for facts past your ` +
				`training data, error messages, recent releases, current documentation. Prefer 3-8 precise ` +
				`keywords over full sentences, and cite the link you used. Do not search for what this ` +
				`conversation already established.`,
			async execute(args) {
				const parsed = args as {
					query?: unknown;
					max_results?: unknown;
				};
				const query = String(parsed.query ?? "").trim();
				if (!query) return { error: "The search needs a query." };
				const max = Math.min(10, Math.max(1, Number(parsed.max_results) || 5));

				// A granted backend always runs first; DuckDuckGo is the
				// fallback for "no provider", never a replacement for one.
				// It needs no credential, so only the gateway path asks for it.
				if (params.searchModelIds.length > 0) {
					if (!params.token) return { error: "No search credential for this session." };
					try {
						// The gateway's own shape, through the unified route; the
						// backend it ran is named back because one search never
						// mixes backends and the citation should say which ran.
						const answer = await gateway.post<{
							results?: { title?: unknown; url?: unknown; snippet?: unknown }[];
							backend?: unknown;
						}>(params.token, "search", { query, max_results: max });
						const backend =
							typeof answer.backend === "string" && answer.backend ? answer.backend : "search";
						return renderHits(
							normaliseGatewayResults(answer.results),
							backend,
							params.allowedFetchUrls
						);
					} catch (err) {
						if (duckDuckGoEnabled && isNoSearchProvider(err)) {
							return runDuckDuckGo(query, max, params.allowedFetchUrls);
						}
						// Model-readable failure, retryable: a refused ceiling, a group
						// with no search policy, or a degraded backend is information
						// the model can act on ("say you could not search"), not an
						// exception to end the turn on. The vendor's own payment
						// challenge (an x402 answer from an unfunded account) arrives
						// inside this message and says what it is.
						const message =
							err instanceof GatewayCallFailed ? err.message : "The search backend is unavailable.";
						return { error: `Search failed: ${message}` };
					}
				}
				if (duckDuckGoEnabled) {
					return runDuckDuckGo(query, max, params.allowedFetchUrls);
				}
				return { error: "Search failed: No search provider is configured." };
			},
		},
	];
}

interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

function normaliseGatewayResults(
	results: { title?: unknown; url?: unknown; snippet?: unknown }[] | undefined
): SearchHit[] {
	if (!Array.isArray(results)) return [];
	return results.flatMap((entry) => {
		if (typeof entry.url !== "string" || !entry.url) return [];
		return [
			{
				title: typeof entry.title === "string" ? entry.title : "untitled",
				url: entry.url,
				snippet: typeof entry.snippet === "string" ? entry.snippet : "",
			},
		];
	});
}

function renderHits(
	hits: SearchHit[],
	backend: string,
	allowedFetchUrls?: Set<string>
): { resultText: string } {
	for (const hit of hits) {
		try {
			const url = new URL(hit.url);
			if (url.protocol === "https:") allowedFetchUrls?.add(url.href);
		} catch {
			// A malformed result is not a fetch capability.
		}
	}
	if (hits.length === 0) {
		return { resultText: "No results. Try different keywords." };
	}
	const rendered = hits
		.map((hit, index) => {
			const parts = [`${index + 1}. ${hit.title}`, hit.url, hit.snippet];
			return parts.filter(Boolean).join("\n");
		})
		.join("\n\n");
	return {
		resultText: `${rendered}\n\n(${hits.length} results via ${backend})`,
	};
}

/** The gateway's unified route answering 404 for a group with no search policy. */
function isNoSearchProvider(err: unknown): boolean {
	return (
		err instanceof GatewayCallFailed &&
		err.status === 404 &&
		/no search provider/i.test(err.message)
	);
}

async function runDuckDuckGo(query: string, max: number, allowedFetchUrls?: Set<string>) {
	try {
		const outcome = await searchDuckDuckGo(query, max);
		if (outcome.blocked) {
			return {
				resultText:
					"DuckDuckGo showed a bot challenge instead of results. " +
					"Say you could not search the web just now.",
			};
		}
		return renderHits(outcome.hits, "duckduckgo", allowedFetchUrls);
	} catch {
		return { error: "Search failed: DuckDuckGo is unreachable right now." };
	}
}
