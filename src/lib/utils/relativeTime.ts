import { m } from "$lib/paraglide/messages";
import { intlLocale } from "$lib/i18n/format";

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
	if (seconds < 60) return m["app.relative_time.just_now"]();
	const formatter = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" });
	for (const [unit, size] of UNITS) {
		if (seconds >= size) return formatter.format(-Math.floor(seconds / size), unit);
	}
	return m["app.relative_time.just_now"]();
}

const COMPACT_UNITS: Array<[Intl.NumberFormatOptions["unit"], number]> = [
	["week", 7 * 24 * 3600],
	["day", 24 * 3600],
	["hour", 3600],
	["minute", 60],
];

/**
 * "2m", "1h", "3d", "2w": how long before `now` a moment was, as the narrow
 * unit form of the locale, for a row with no room for "2 hours ago". Under a
 * minute (or an unreadable date) is an empty string: the caller omits it
 * rather than showing a count that is stale by the time it is read.
 */
export function formatCompactAge(
	date: Date | string | number | undefined | null,
	now: Date | number = Date.now(),
	locale?: string
): string {
	if (date === undefined || date === null) return "";
	const seconds = Math.round((new Date(now).getTime() - new Date(date).getTime()) / 1000);
	if (!Number.isFinite(seconds) || seconds < 60) return "";
	for (const [unit, size] of COMPACT_UNITS) {
		if (seconds >= size) {
			return new Intl.NumberFormat(intlLocale(locale), {
				style: "unit",
				unit,
				unitDisplay: "narrow",
			}).format(Math.floor(seconds / size));
		}
	}
	return "";
}
