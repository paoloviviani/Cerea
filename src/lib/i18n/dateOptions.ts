/**
 * The options that make `formatDateTime` read like `toLocaleString()` did
 * (numeric date, then time with seconds), for hover titles that give the exact
 * moment behind a relative "3 hours ago".
 */
export const FULL_DATE_TIME: Intl.DateTimeFormatOptions = {
	year: "numeric",
	month: "numeric",
	day: "numeric",
	hour: "numeric",
	minute: "numeric",
	second: "numeric",
};
