/**
 * Split out from `webFetchTool.ts` so `toolInvocation.ts` (the tool-approval
 * gate) can read `canonicalUrl` without importing the builtin's execute logic
 * back — a cycle that left bindings like `GatewayCallFailed` pointing at a
 * not-yet-initialized module in some load orders.
 */

import { toggleTrailingSlash } from "$lib/server/fetching/status";

export const WEB_FETCH_TOOL_NAME = "web_fetch";

/** Canonical form used for the provenance set, not an SSRF validation step. */
export function canonicalUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

/**
 * Whether a URL was supplied or approved. The same address with its trailing
 * slash toggled is the same resource, so approving `/feed/` covers `/feed`
 * (the fetch retries that spelling when the first is refused).
 */
export function isAllowedUrl(allowed: Set<string>, url: string): boolean {
	if (allowed.has(url)) return true;
	const toggled = toggleTrailingSlash(url);
	return toggled !== null && allowed.has(toggled);
}
