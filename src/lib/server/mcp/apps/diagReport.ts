/** What the MCP App diagnostics route accepts and keeps (see the route's header). */

/** The kinds the card's shim can report. The message text is never sent, never logged. */
export const DIAG_KINDS = ["error", "resource", "rejection", "csp", "closed"] as const;

const MAX_REPORTS_PER_MINUTE = 10;
const reports = new Map<string, number[]>();

/** Scheme, host and path of an address, nothing after: no query, no fragment, no credentials. */
export function reduceSource(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol;
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 200);
	} catch {
		return undefined;
	}
}

/** Records a report under a bucket and says whether it is within the limit. */
export function reportAllowed(key: string, now = Date.now()): boolean {
	const recent = (reports.get(key) ?? []).filter((at) => now - at < 60_000);
	if (recent.length >= MAX_REPORTS_PER_MINUTE) {
		reports.set(key, recent);
		return false;
	}
	recent.push(now);
	reports.set(key, recent);
	return true;
}

export function pruneReports(now = Date.now()): void {
	if (reports.size <= 5000) return;
	for (const [k, list] of reports) if (list.every((at) => now - at >= 60_000)) reports.delete(k);
}

export function resetReports(): void {
	reports.clear();
}
