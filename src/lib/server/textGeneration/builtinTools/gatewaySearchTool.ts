import { config } from "$lib/server/config";
import { gateway } from "$lib/server/gatewayServer";
import type { BuiltinTool } from "./types";

/**
 * The gateway's own web search, as a builtin (ADR 0058's plan, phase 2).
 *
 * This is not the provider-side search tool, which rides inside the
 * completion request and is metered by the counterparty's report. This one
 * calls `POST /v1/search` — the gateway's backends, its tiers, its ledger —
 * with **the user's token**, so the search is metered to the person who asked
 * for it and capped by their ceiling, exactly like any other surface. The
 * results come back normalised (url, title, snippet), because swapping
 * Linkup for Exa is an administrator's edit and not something a caller
 * should parse twice.
 *
 * **Gated on a search model existing in the caller's catalogue**, the same
 * rule the GitHub tools apply to `GITHUB_TOKEN`: a tool that is offered and
 * always fails costs the model a turn to discover that. Which search models
 * exist *is* the administrator's grant — the tier is the model — so the
 * catalogue is the feature switch and the permission in one.
 */

interface GatewaySearchResult {
	url: string;
	title: string;
	snippet: string;
	content?: string | null;
	published_at?: string | null;
}

interface GatewaySearchResponse {
	object: string;
	model: string;
	backend: string;
	results: GatewaySearchResult[];
	search: { requests: number };
}

export const WEB_SEARCH_TOOL_NAME = "web_search";

/**
 * The `kind: "search"` model ids this caller may use, or none.
 *
 * Not the chat's catalogue — that deliberately serves chat models only
 * (search is not something to chat *with*), so the raw `/models` list is read
 * here with the caller's token, which is also what makes the answer
 * per-caller: a search tier is a grant, and somebody without it sees no tool.
 * A gateway that cannot be asked yields none — the turn loses the tool and
 * keeps the answer, the same direction every degradation in this pipeline
 * takes.
 */
export async function findSearchModelIds(bearer: string): Promise<string[]> {
	const base = config.OPENAI_BASE_URL?.replace(/\/$/, "");
	if (!base) return [];
	try {
		const response = await fetch(`${base}/models`, {
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
	/** Ids of the `kind: "search"` models this caller may use. */
	searchModelIds: string[];
}): BuiltinTool[] {
	if (params.searchModelIds.length === 0) return [];
	// The tier is a grant, not a parameter (ADR 0058): the first search model
	// the catalogue offers is the depth this tool runs, and offering two would
	// ask the model to make an administrator's decision.
	const model = params.searchModelIds[0];
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
				const query = String((args as { query?: unknown }).query ?? "").trim();
				if (!query) return { error: "The search needs a query." };
				if (!params.token) return { error: "No search credential for this session." };
				const max = Math.min(
					10,
					Math.max(1, Number((args as { max_results?: unknown }).max_results) || 5)
				);
				try {
					const answer = await gateway.post<GatewaySearchResponse>(params.token, "search", {
						model,
						query,
						max_results: max,
					});
					if (answer.results.length === 0) {
						return { resultText: "No results. Try different keywords." };
					}
					const rendered = answer.results
						.map((hit, index) => {
							const parts = [`${index + 1}. ${hit.title || "untitled"}`, hit.url, hit.snippet];
							return parts.filter(Boolean).join("\n");
						})
						.join("\n\n");
					return {
						resultText: `${rendered}\n\n(${answer.results.length} results via ${answer.backend})`,
					};
				} catch (err) {
					// Model-readable failure, retryable: a refused ceiling or a
					// degraded backend is information the model can act on ("say you
					// could not search"), not an exception to end the turn on.
					const message = err instanceof Error ? err.message : "The search backend is unavailable.";
					return { error: `Search failed: ${message}` };
				}
			},
		},
	];
}
