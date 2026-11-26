/**
 * Rate limit for the tool calls an MCP App page starts (docs/dev/adr-mcp-apps.md, section 3): a page is
 * untrusted code and a loop in it must not hammer a connector with the user's credential. In process and
 * per conversation and user, which is the unit a page belongs to. 120 a minute leaves room for an app that
 * saves its work every second through a page-only tool, with a user's clicks on top; a burst of 8 in a
 * second covers the handful of parallel reads a page makes when it loads. A looping page still hits it at once.
 */
export const PAGE_CALLS_PER_MINUTE = 120;
/** At most this many calls started within one second: a page that fires them all at once is looping. */
export const PAGE_CALLS_BURST = 8;

const WINDOW_MS = 60_000;
const calls = new Map<string, number[]>();

/** Records a call and says whether it is allowed. Past the limit nothing is recorded. */
export function pageCallAllowed(key: string, now = Date.now()): boolean {
	const recent = (calls.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
	const lastSecond = recent.filter((at) => now - at < 1000).length;
	if (recent.length >= PAGE_CALLS_PER_MINUTE || lastSecond >= PAGE_CALLS_BURST) {
		calls.set(key, recent);
		return false;
	}
	recent.push(now);
	calls.set(key, recent);
	if (calls.size > 5000) {
		for (const [k, list] of calls) {
			if (list.every((at) => now - at >= WINDOW_MS)) calls.delete(k);
		}
	}
	return true;
}

export function resetPageCallLimit(): void {
	calls.clear();
}
