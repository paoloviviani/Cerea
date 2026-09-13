import { config } from "$lib/server/config";
import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";
import type { BuiltinTool } from "./types";

/**
 * The gateway's search backends, as a builtin — through the passthrough
 * (ADR 0071).
 *
 * The gateway does not translate: `POST /v1/search/{backend}` takes the
 * vendor's own request body and returns the vendor's own answer. This file is
 * therefore where the per-vendor vocabulary lives — one adapter per backend
 * that builds the request and reads the response — because the caller that
 * assembles the request is the one place it can live without becoming a layer
 * the gateway maintains.
 *
 * **Gated on a backend being granted to the caller** (`/v1/models
 * ?include=search`), the same rule the GitHub tools apply to `GITHUB_TOKEN`:
 * a tool that is offered and always fails costs the model a turn to discover
 * that. The grant is the feature switch and the permission in one.
 */

/** One vendor's request shape, response shape, and the field it searches by. */
interface SearchAdapter {
	backend: string;
	/** Build the vendor's own request body. */
	build: (query: string, depth: string | undefined, maxResults: number) => Record<string, unknown>;
	/** Read the vendor's own response into results, best-effort. */
	read: (payload: unknown) => { title: string; url: string; snippet: string }[];
}

/**
 * Linkup: `q`/`depth`/`outputType`, and results named `name` not `title`.
 *
 * `depth` is a required enum of exactly four words — the model will
 * eventually guess a word from another vendor's vocabulary, and a guaranteed
 * 400 is not a result: unknown words fall back to the vendor's recommended
 * default rather than being forwarded to fail.
 */
const LINKUP_DEPTHS = new Set(["deep", "fast", "flash", "standard"]);
const LINKUP: SearchAdapter = {
	backend: "linkup",
	build: (query, depth, maxResults) => ({
		q: query,
		depth: depth && LINKUP_DEPTHS.has(depth) ? depth : "standard",
		outputType: "searchResults",
		maxResults,
	}),
	read: (payload) => {
		const results = (payload as { results?: unknown }).results;
		if (!Array.isArray(results)) return [];
		return results.flatMap((entry) => {
			const record = entry as { name?: unknown; url?: unknown; content?: unknown };
			if (typeof record.url !== "string" || !record.url) return [];
			return [
				{
					title: typeof record.name === "string" ? record.name : "untitled",
					url: record.url,
					snippet: typeof record.content === "string" ? record.content : "",
				},
			];
		});
	},
};

/**
 * Exa: `query`/`type`/`numResults`, text as a separate charge.
 *
 * The accepted `type` values are Exa's own business and they change — the
 * authoritative list as of today came from their validation error, not their
 * docs (which serve a stale enum): neural, keyword, auto, hybrid, fast, blue,
 * deep-reasoning, deep-lite, magic, deep, instant. An unknown word is omitted
 * — Exa defaults to `auto` — because forwarding it forwards a 400.
 */
const EXA_TYPES = new Set([
	"neural",
	"keyword",
	"auto",
	"hybrid",
	"fast",
	"blue",
	"deep-reasoning",
	"deep-lite",
	"magic",
	"deep",
	"instant",
]);
const EXA: SearchAdapter = {
	backend: "exa",
	build: (query, depth, maxResults) => ({
		query,
		...(depth && EXA_TYPES.has(depth) ? { type: depth } : {}),
		numResults: maxResults,
	}),
	read: (payload) => {
		const results = (payload as { results?: unknown }).results;
		if (!Array.isArray(results)) return [];
		return results.flatMap((entry) => {
			const record = entry as { title?: unknown; url?: unknown; summary?: unknown; text?: unknown };
			if (typeof record.url !== "string" || !record.url) return [];
			return [
				{
					title: typeof record.title === "string" ? record.title : "untitled",
					url: record.url,
					snippet:
						(typeof record.summary === "string" ? record.summary : "") ||
						(typeof record.text === "string" ? record.text : ""),
				},
			];
		});
	},
};

const ADAPTERS: Record<string, SearchAdapter> = { linkup: LINKUP, exa: EXA };

export const WEB_SEARCH_TOOL_NAME = "web_search";

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
}): BuiltinTool[] {
	if (params.searchModelIds.length === 0) return [];
	// The backend is a grant, not the model's choice: with one backend there is
	// no parameter at all, and with several the enum carries only the granted
	// ones — a depth word is the vendor's pricing, and choosing it was never
	// the model's decision to make alone.
	const backendEnum = params.searchModelIds;
	const first = backendEnum[0];
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
							...(backendEnum.length > 1
								? {
										backend: {
											type: "string",
											enum: backendEnum,
											description: "Which search backend to ask.",
										},
									}
								: {}),
							depth: {
								type: "string",
								description:
									"How hard to search, in the backend's own words. Unknown words are " +
									"ignored and the backend's default is used — usually the right call.",
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
					backend?: unknown;
					depth?: unknown;
					max_results?: unknown;
				};
				const query = String(parsed.query ?? "").trim();
				if (!query) return { error: "The search needs a query." };
				if (!params.token) return { error: "No search credential for this session." };

				const asked = typeof parsed.backend === "string" ? parsed.backend : first;
				const adapter = ADAPTERS[asked];
				if (!adapter) {
					return { error: `No adapter for the backend "${asked}".` };
				}
				const depth = typeof parsed.depth === "string" ? parsed.depth.trim() : undefined;
				const max = Math.min(10, Math.max(1, Number(parsed.max_results) || 5));
				try {
					// The vendor's own body, through the gateway's passthrough; the
					// answer comes back in the vendor's own shape and is read here,
					// where the vendor's vocabulary belongs.
					const payload = await gateway.post<unknown>(
						params.token,
						`search/${adapter.backend}`,
						adapter.build(query, depth, max)
					);
					const results = adapter.read(payload);
					if (results.length === 0) {
						return { resultText: "No results. Try different keywords." };
					}
					const rendered = results
						.map((hit, index) => {
							const parts = [`${index + 1}. ${hit.title}`, hit.url, hit.snippet];
							return parts.filter(Boolean).join("\n");
						})
						.join("\n\n");
					return {
						resultText: `${rendered}\n\n(${results.length} results via ${adapter.backend})`,
					};
				} catch (err) {
					// Model-readable failure, retryable: a refused ceiling or a
					// degraded backend is information the model can act on ("say you
					// could not search"), not an exception to end the turn on. The
					// vendor's own payment challenge (an x402 answer from an unfunded
					// account) arrives inside this message and says what it is.
					const message =
						err instanceof GatewayCallFailed ? err.message : "The search backend is unavailable.";
					return { error: `Search failed: ${message}` };
				}
			},
		},
	];
}
