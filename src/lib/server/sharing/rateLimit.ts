/**
 * A per-IP fixed-window limiter for the public share routes. In process and
 * approximate on purpose: nothing here is a security boundary (tokens are 128
 * random bits); it keeps a scanner or a hot link from loading the database.
 */
const WINDOW_MS = 60_000;
export const SHARE_REQUESTS_PER_MINUTE = 120;

const windows = new Map<string, { start: number; count: number }>();

export function shareRateLimited(ip: string | undefined, now = Date.now()): boolean {
	const key = ip ?? "unknown";
	const entry = windows.get(key);
	if (!entry || now - entry.start >= WINDOW_MS) {
		if (windows.size > 20_000) {
			for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k);
			if (windows.size > 20_000) windows.clear();
		}
		windows.set(key, { start: now, count: 1 });
		return false;
	}
	entry.count += 1;
	return entry.count > SHARE_REQUESTS_PER_MINUTE;
}

export function resetShareRateLimit(): void {
	windows.clear();
}
