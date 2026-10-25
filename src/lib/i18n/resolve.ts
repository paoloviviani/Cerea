/**
 * Which language a request is in. Pure: no `window`, no `Request`, no
 * database, so the whole policy is unit-testable and the server hook, the
 * Settings selector and the tests all use the same answer.
 *
 * The order, first match wins:
 *
 *   1. the person's saved choice (their settings, which follow them across
 *      devices; for a signed-out session, that session's settings),
 *   2. the choice cookie (what the selector wrote in this browser),
 *   3. the browser's Accept-Language,
 *   4. the base locale (English).
 *
 * A pseudo-locale (`en-XA`) is a lens for developers, not a language. It is
 * honoured from 1 and 2 only while `pseudo` is true (dev, or the deployment
 * flag `CHAT_PSEUDO_LOCALE=true`), and never from Accept-Language: a browser
 * that happens to ask for it must not get a page of accented English.
 */
import { baseLocale, locales } from "$lib/paraglide/runtime.js";
import type { Locale } from "$lib/paraglide/runtime.js";

export type { Locale };
export { baseLocale };

/**
 * Locales that exist to be looked at rather than read. Named, not inferred
 * from the tag, because "a tag containing XA" is a guess and this list decides
 * what a person may choose. Same list as the console's.
 */
export const PSEUDO_LOCALES: readonly string[] = ["en-XA"];

/** Every locale the catalogue carries, pseudo included. */
export const allLocales: readonly Locale[] = locales;

/** Locales a person may choose: the real ones, plus the pseudo ones when `pseudo`. */
export function selectableLocales(pseudo: boolean): Locale[] {
	return locales.filter((locale) => pseudo || !PSEUDO_LOCALES.includes(locale));
}

/** A tag, compared case-insensitively (`en-xa` is `en-XA`), to a locale we carry. */
function exact(tag: unknown, allowed: readonly Locale[]): Locale | undefined {
	if (typeof tag !== "string") return undefined;
	const wanted = tag.trim().toLowerCase();
	return allowed.find((locale) => locale.toLowerCase() === wanted);
}

/** The locale a stored value names, if it is one this deployment may serve. */
export function parseLocale(value: unknown, pseudo = false): Locale | undefined {
	return exact(value, selectableLocales(pseudo));
}

/**
 * The tags of an `Accept-Language` header, best first.
 *
 * Sorted by `q` (stable, so equal weights keep their written order); `q=0`
 * means "not acceptable" and is dropped; `*` is no preference and is dropped.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
	if (!header) return [];
	return header
		.split(",")
		.map((part, index) => {
			const [tag = "", ...params] = part.trim().split(";");
			const q = params
				.map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p))
				.find((match) => match !== null)?.[1];
			const weight = q === undefined ? 1 : Number(q);
			return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
		})
		.filter(({ tag, weight }) => tag !== "" && tag !== "*" && weight > 0)
		.sort((a, b) => b.weight - a.weight || a.index - b.index)
		.map(({ tag }) => tag);
}

/**
 * The best real locale for an `Accept-Language` header: the full tag first,
 * then its language (`it-CH` gets an `it` catalogue if there is one, and no
 * answer otherwise, so the next tag is tried).
 */
export function matchAcceptLanguage(header: string | null | undefined): Locale | undefined {
	const real = selectableLocales(false);
	for (const tag of parseAcceptLanguage(header)) {
		const match = exact(tag, real) ?? exact(tag.split("-")[0], real);
		if (match) return match;
	}
	return undefined;
}

export interface LocaleInputs {
	/** `settings.locale` for this person or session, as stored (untrusted). */
	saved?: unknown;
	/** The choice cookie's value (untrusted). */
	cookie?: unknown;
	/** The raw `Accept-Language` header. */
	acceptLanguage?: string | null;
	/** Whether pseudo-locales may be selected (dev or the deployment flag). */
	pseudo?: boolean;
}

export function resolveLocale({
	saved,
	cookie,
	acceptLanguage,
	pseudo = false,
}: LocaleInputs): Locale {
	return (
		parseLocale(saved, pseudo) ??
		parseLocale(cookie, pseudo) ??
		matchAcceptLanguage(acceptLanguage) ??
		baseLocale
	);
}
