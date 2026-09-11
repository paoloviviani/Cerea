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

import { StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { Client } from "@modelcontextprotocol/client";
import { createMcpClient } from "$lib/server/mcp/client";
import { logger } from "$lib/server/logger";
import { mcpFetch } from "$lib/server/urlSafety";

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

async function connectAndList(
	transport: StreamableHTTPClientTransport | SSEClientTransport
): Promise<McpToolSummary[]> {
	const client: Client = createMcpClient("health");
	try {
		await client.connect(transport);
		const response = await client.listTools();
		return (response?.tools ?? []).map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		}));
	} finally {
		// Always, including on the failure path: a client left open holds a
		// connection to somebody else's server for as long as the process runs.
		try {
			await client.close();
		} catch {
			// Nothing useful to do about a failed close.
		}
	}
}

/**
 * Ask a server what it can do.
 *
 * `headers` is whatever the caller has decided to send — for a connector that
 * is the sealed credential, unsealed here and never anywhere near a browser.
 */
export async function listTools(
	url: string,
	headers: Record<string, string> = {}
): Promise<ToolListing> {
	const baseUrl = new URL(url);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
	const requestInit: RequestInit = {
		headers: { Accept: "application/json, text/event-stream", ...headers },
		signal: controller.signal,
	};

	try {
		let httpError: Error | undefined;
		try {
			const tools = await connectAndList(
				new StreamableHTTPClientTransport(baseUrl, { requestInit, fetch: mcpFetch })
			);
			return { ok: true, tools };
		} catch (error) {
			httpError = error instanceof Error ? error : new Error(String(error));
			logger.warn({ err: httpError }, "[mcp] streamable HTTP failed, trying SSE");
		}

		try {
			const tools = await connectAndList(
				new SSEClientTransport(baseUrl, { requestInit, fetch: mcpFetch })
			);
			return { ok: true, tools };
		} catch (error) {
			const sseError = error instanceof Error ? error : new Error(String(error));
			// The HTTP error is reported in preference to the SSE one: a server
			// answering 500 over HTTP produces a useless "SSE failed" message,
			// and the primary failure is the one worth showing.
			const message = `HTTP transport failed: ${httpError?.message ?? "unknown"}; SSE fallback failed: ${sseError.message}`;
			logger.error({ err: sseError }, "[mcp] both transports failed");
			return {
				ok: false,
				error: message,
				authRequired: looksLikeAuthFailure(httpError?.message ?? message),
			};
		}
	} finally {
		clearTimeout(timeout);
	}
}
