/**
 * Dates, times, relative times and numbers in the active language.
 *
 * Everything user-visible goes through `Intl` with the locale the page is in
 * (`activeLocale()`), never a hard-coded `en-US`, and never `undefined` (which
 * would mean the *browser's* language, so a page in one language would show
 * dates in another). Each helper takes an optional `locale` so a test, or a
 * caller that already holds one, can pin it.
 *
 * Two things are deliberately NOT here: machine formats (ISO timestamps, ids,
 * the clock line given to the model), which stay `en-US`/UTC on purpose and
 * say so, and prose with numbers in it, which belongs in a message with a
 * `{count: number}` / plural declaration so the translator owns the sentence.
 */
import { activeLocale } from "./locale";
import { PSEUDO_LOCALES } from "./resolve";

/**
 * The tag `Intl` should be given for a locale. A pseudo-locale is English with
 * its words marked, so its numbers and dates are English's; handing `Intl` the
 * private region tag would work in some engines and throw in others.
 */
export function intlLocale(locale: string = activeLocale()): string {
	return PSEUDO_LOCALES.includes(locale) ? (locale.split("-")[0] ?? locale) : locale;
}

type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
	return value instanceof Date ? value : new Date(value);
}

/** An invalid date is shown as nothing, not as "Invalid Date" in any language. */
function valid(date: Date): boolean {
	return !Number.isNaN(date.getTime());
}

export function formatDate(
	value: DateInput,
	options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
	locale?: string
): string {
	const date = toDate(value);
	return valid(date) ? new Intl.DateTimeFormat(intlLocale(locale), options).format(date) : "";
}

export function formatDateTime(
	value: DateInput,
	options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
	locale?: string
): string {
	return formatDate(value, options, locale);
}

export function formatNumber(
	value: number,
	options?: Intl.NumberFormatOptions,
	locale?: string
): string {
	return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

/**
 * A money amount. An unrecognised currency code (it comes from the gateway)
 * falls back to the plain number rather than throwing during render.
 */
export function formatCurrency(value: number, currency: string, locale?: string): string {
	try {
		return formatNumber(value, { style: "currency", currency }, locale);
	} catch {
		return formatNumber(value, undefined, locale);
	}
}

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
	["year", 365 * 24 * 3600 * 1000],
	["month", 30 * 24 * 3600 * 1000],
	["week", 7 * 24 * 3600 * 1000],
	["day", 24 * 3600 * 1000],
	["hour", 3600 * 1000],
	["minute", 60 * 1000],
];

/**
 * "3 hours ago", "in 2 days", "now": the largest whole unit that fits,
 * rounded toward zero so "59 minutes" does not read as "1 hour".
 * `numeric: "auto"` gives "yesterday" / "tomorrow" where the language has them.
 */
export function formatRelativeTime(
	value: DateInput,
	now: DateInput = Date.now(),
	locale?: string
): string {
	const date = toDate(value);
	if (!valid(date)) return "";
	const diff = date.getTime() - toDate(now).getTime();
	const formatter = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" });
	for (const [unit, size] of UNITS) {
		if (Math.abs(diff) >= size) return formatter.format(Math.trunc(diff / size), unit);
	}
	return formatter.format(Math.trunc(diff / 1000), "second");
}
