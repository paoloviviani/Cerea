const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	["year", 365 * 24 * 3600],
	["month", 30 * 24 * 3600],
	["week", 7 * 24 * 3600],
	["day", 24 * 3600],
	["hour", 3600],
	["minute", 60],
];

/**
 * "3 hours ago", "yesterday", "2 weeks ago": how long before `now` a moment
 * was, in the largest unit that fits. Under a minute is "just now" rather than
 * a count of seconds that would be stale by the time it is read.
 */
export function formatRelativeTime(
	date: Date | string | number,
	now: Date | number = Date.now(),
	locale?: string
): string {
	const seconds = Math.round((new Date(now).getTime() - new Date(date).getTime()) / 1000);
	if (!Number.isFinite(seconds)) return "";
	if (seconds < 60) return "just now";
	const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	for (const [unit, size] of UNITS) {
		if (seconds >= size) return formatter.format(-Math.floor(seconds / size), unit);
	}
	return "just now";
}
