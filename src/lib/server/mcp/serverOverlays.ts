/**
 * What may be called of a server: public HTTPS only (a local connector's internal address is
 * checked by its opener), plus the per-server overlays: the person's HF token on the official
 * HF MCP server when the deployment forwards it, and the deployment's Exa key on mcp.exa.ai.
 *
 * One function for the turn and for the catalogue refresh (ADR 0104), so the refresh lists a
 * server exactly as a turn would call it. The refresh passes no token: what it records is never
 * a listing made with somebody's credential.
 */

import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { isValidUrl } from "$lib/server/urlSafety";
import { isLocalServerUrl } from "./localUrl";
import { hasAuthHeader, isStrictHfMcpLogin, hasNonEmptyToken, isExaMcpServer } from "./hf";
import type { McpServerConfig } from "./httpClient";

export function callableServers(input: McpServerConfig[], token?: string): McpServerConfig[] {
	let list: McpServerConfig[] = input.map((s) => ({ ...s }));
	// Enforce server-side safety (public HTTPS only, no private ranges by default)
	{
		const before = list.slice();
		list = list.filter((s) => {
			try {
				// A local connector's address is internal (`machine://`, produced only by the
				// selection resolution) and is checked by its opener, not by this public-URL rule.
				return isLocalServerUrl(s.url) || isValidUrl(s.url, { allowInsecure: true });
			} catch {
				return false;
			}
		});
		try {
			const rejected = before.filter((b) => !list.includes(b));
			if (rejected.length > 0) {
				logger.warn(
					{ rejected: rejected.map((r) => ({ name: r.name, url: r.url })) },
					"[mcp] rejected servers by URL safety"
				);
			}
		} catch {}
	}
	// Optionally attach the logged-in user's HF token to the official HF MCP server only.
	// Never override an explicit Authorization header, and require token to look like an HF token.
	try {
		const shouldForward = config.MCP_FORWARD_HF_USER_TOKEN === "true";
		const userToken = token;
		if (shouldForward && hasNonEmptyToken(userToken)) {
			list = list.map((s) => {
				try {
					if (isStrictHfMcpLogin(s.url) && !hasAuthHeader(s.headers)) {
						return {
							...s,
							headers: { ...(s.headers ?? {}), Authorization: `Bearer ${userToken}` },
						};
					}
				} catch {
					// ignore URL parse errors and leave server unchanged
				}
				return s;
			});
		}
	} catch {
		// best-effort overlay; continue if anything goes wrong
	}
	// Inject Exa API key for mcp.exa.ai servers via URL param (mcp.exa.ai doesn't support headers)
	try {
		const exaApiKey = config.EXA_API_KEY;
		if (hasNonEmptyToken(exaApiKey)) {
			list = list.map((s) => {
				try {
					if (isExaMcpServer(s.url)) {
						const url = new URL(s.url);
						if (!url.searchParams.has("exaApiKey")) {
							url.searchParams.set("exaApiKey", exaApiKey);
							return { ...s, url: url.toString() };
						}
					}
				} catch {}
				return s;
			});
		}
	} catch {
		// best-effort injection; continue if anything goes wrong
	}
	return list;
}
