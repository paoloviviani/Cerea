/**
 * Connect to an MCP server and list its tools.
 *
 * Extracted from `src/routes/api/mcp/health/+server.ts`, which had the only
 * copy of the transport dance: try Streamable HTTP, fall back to SSE, and
 * report the *HTTP* error when both fail, because the SSE message is almost
 * always the less informative of the two. Connectors need exactly this and it
 * would otherwise have been written twice.
 *
 * What stayed in the route rather than moving here is everything that is
 * specific to a client-supplied server: the Exa API-key injection, the
 * HuggingFace user-token overlay, and turning a transport error into a
 * sentence for a form. Those run before or after this, not inside it.
 *
 * Note the `authRequired` heuristic is a *string match on an error message*,
 * which is as weak as it looks. It is kept because it is the only signal these
 * transports surface, and it is no longer load-bearing: a connector learns
 * whether it needs OAuth from `discovery.ts`, which reads the protocol's own
 * metadata instead of guessing.
 */

import { getClient, releaseClient, retainClient } from "$lib/server/mcp/clientPool";
import { logger } from "$lib/server/logger";

export interface McpToolSummary {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export type ToolListing =
	{ ok: true; tools: McpToolSummary[] } | { ok: false; error: string; authRequired: boolean };

/** How long to wait before giving up on somebody else's server. */
const TIMEOUT_MS = 30_000;

function looksLikeAuthFailure(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		lower.includes("unauthorized") ||
		lower.includes("forbidden") ||
		lower.includes("401") ||
		lower.includes("403")
	);
}

/**
 * Ask a server what it can do.
 *
 * `headers` is whatever the caller has decided to send — for a connector that
 * is the sealed credential, unsealed here and never anywhere near a browser.
 *
 * The listing rides the client pool, so a re-check reuses a warm connection
 * instead of paying a cold handshake every time (a ping covers an idle one,
 * and the sweeper still owns disposal). The pool key carries the full
 * headers, so a credentialed check never borrows another caller's
 * connection. `kind: "health"` keeps these clients apart from chat-time
 * ones, which initialize as a different identity.
 */
export async function listTools(
	url: string,
	headers: Record<string, string> = {}
): Promise<ToolListing> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		const client = await getClient(
			{
				name: "health",
				url,
				headers: { Accept: "application/json, text/event-stream", ...headers },
			},
			controller.signal,
			undefined,
			"health"
		);
		retainClient(client);
		try {
			const response = await client.listTools({}, { signal: controller.signal });
			const tools = (response?.tools ?? []).map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			}));
			return { ok: true, tools };
		} finally {
			releaseClient(client);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error({ err: error }, "[mcp] pooled health listing failed");
		return {
			ok: false,
			error: message,
			authRequired: looksLikeAuthFailure(message),
		};
	} finally {
		clearTimeout(timeout);
	}
}
