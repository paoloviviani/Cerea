/**
 * Split out from `webFetchTool.ts` so `toolInvocation.ts` (the tool-approval
 * gate) can read `canonicalUrl` without importing the builtin's execute logic
 * back — a cycle that left bindings like `GatewayCallFailed` pointing at a
 * not-yet-initialized module in some load orders.
 */

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
