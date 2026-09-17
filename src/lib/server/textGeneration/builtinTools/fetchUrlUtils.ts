/**
 * Split out from `webFetchTool.ts` so the modules it wires in (`fetchVerification.ts`,
 * `fetchApproval.ts`) don't import back from it — a cycle that left bindings like
 * `GatewayCallFailed` pointing at a not-yet-initialized module in some load orders.
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

/** Lowercased hostname, or null for an unparseable URL. Used for domain-scoped approval. */
export function hostnameOf(value: string): string | null {
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return null;
	}
}
