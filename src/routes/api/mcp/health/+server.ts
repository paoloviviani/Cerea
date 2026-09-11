/**
 * Health check for a server the client names: can we reach it, and what tools
 * does it have?
 *
 * The transport dance moved to `$lib/server/mcp/health` so connectors could
 * use it too. What stays here is what is specific to a *client-supplied*
 * server: the Exa key injection, the HuggingFace user-token overlay, and
 * turning a transport error into a sentence somebody can act on.
 *
 * One of those sentences used to be the whole story for authentication —
 * "provide appropriate Authorization headers in the server configuration" —
 * which is the dead end ADR 0064 exists to remove. It is still the right thing
 * to say about an ad-hoc server typed into a form; the way out of it is to add
 * the thing as a connector, which the message now says.
 */

import type { KeyValuePair } from "$lib/types/Tool";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import type { RequestHandler } from "./$types";
import { isValidUrl } from "$lib/server/urlSafety";
import { listTools } from "$lib/server/mcp/health";
import { isStrictHfMcpLogin, hasNonEmptyToken, isExaMcpServer } from "$lib/server/mcp/hf";

interface HealthCheckRequest {
	url: string;
	headers?: KeyValuePair[];
}

interface HealthCheckResponse {
	ready: boolean;
	tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
	error?: string;
	authRequired?: boolean;
}

function json(body: HealthCheckResponse, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Exa takes its key in the URL rather than a header. Best effort. */
function withExaKey(url: string): string {
	try {
		const key = config.EXA_API_KEY;
		if (!isExaMcpServer(url) || !hasNonEmptyToken(key)) return url;
		const parsed = new URL(url);
		if (parsed.searchParams.has("exaApiKey")) return url;
		parsed.searchParams.set("exaApiKey", key);
		logger.debug({}, "[MCP Health] injected Exa API key");
		return parsed.toString();
	} catch {
		return url;
	}
}

/** Say what to do about a failure, rather than restating it. */
function explain(url: string, error: string, authRequired: boolean): string {
	if (authRequired) {
		return (
			"Authentication required. Add this as a connector and sign in, or give it a " +
			"token — a credential typed in here would live in this browser."
		);
	}
	if (error.includes("not valid JSON")) {
		return (
			"Server returned invalid response. This might not be a valid MCP endpoint. MCP " +
			"servers should respond to POST requests at /mcp with JSON-RPC messages."
		);
	}
	if (error.includes("fetch failed") || error.includes("ECONNREFUSED")) {
		return `Cannot connect to ${url}. Please verify the server is running and accessible.`;
	}
	if (error.includes("CORS")) {
		return "CORS error. The MCP server needs to allow requests from this origin.";
	}
	return error;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const { url, headers }: HealthCheckRequest = await request.json();

		if (!url) return json({ ready: false, error: "URL is required" }, 400);
		if (!isValidUrl(url, { allowInsecure: true })) {
			return json({ ready: false, error: "Invalid or unsafe URL (only HTTPS is supported)" }, 400);
		}

		const headersRecord: Record<string, string> = headers?.length
			? Object.fromEntries(headers.map((h) => [h.key, h.value]))
			: {};

		// The logged-in user's HF token, only for the official HF endpoint and
		// only when the deployment opted in.
		try {
			const userToken =
				(locals as unknown as { hfAccessToken?: string } | undefined)?.hfAccessToken ??
				(locals as unknown as { token?: string } | undefined)?.token;
			if (
				config.MCP_FORWARD_HF_USER_TOKEN === "true" &&
				typeof headersRecord["Authorization"] !== "string" &&
				isStrictHfMcpLogin(url) &&
				hasNonEmptyToken(userToken)
			) {
				headersRecord["Authorization"] = `Bearer ${userToken}`;
			}
		} catch {
			// best-effort overlay
		}

		const result = await listTools(withExaKey(url), headersRecord);

		if (result.ok) {
			if (result.tools.length === 0) {
				return json(
					{ ready: false, error: "Connected but no tools available", authRequired: false },
					503
				);
			}
			return json({ ready: true, tools: result.tools, authRequired: false }, 200);
		}

		return json(
			{
				ready: false,
				error: explain(url, result.error, result.authRequired),
				authRequired: result.authRequired,
			},
			503
		);
	} catch (error) {
		logger.error(error, "MCP health check failed");
		return json(
			{ ready: false, error: error instanceof Error ? error.message : "Unknown error" },
			503
		);
	}
};
