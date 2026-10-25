/**
 * The client's door onto the active language: the cookie the selector writes,
 * and the handover from the server's decision to Paraglide.
 *
 * What the language *is* for a request is `resolve.ts`; this file only moves
 * that answer around in the browser.
 */
import { baseLocale, getLocale, overwriteGetLocale } from "$lib/paraglide/runtime.js";
import type { Locale } from "$lib/paraglide/runtime.js";
import { PSEUDO_LOCALES, parseLocale } from "./resolve";

/** Same string as `cookieName` in project.inlang/paraglide.config.ts. */
export const LOCALE_COOKIE = "cerea_locale";

/** One year: a language is a long-lived preference, not a session one. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** The locale the page is in right now. Never throws. */
export function activeLocale(): Locale {
	try {
		return getLocale();
	} catch {
		return baseLocale;
	}
}

/**
 * Make the browser's Paraglide answer what the server rendered with.
 *
 * Called from the root layout before any message is read. The server put the
 * same locale in `<html lang>` and in the layout data, so the first client
 * render produces exactly the HTML that was sent. Without this the client
 * would re-resolve from the cookie alone and disagree whenever the server
 * used the saved setting or Accept-Language.
 */
export function adoptServerLocale(locale: Locale | undefined): void {
	// Browser only. On the server `getLocale` is already per-request (the hook
	// runs each render in Paraglide's AsyncLocalStorage); overwriting it there
	// would make one request's language global to all of them.
	if (typeof window === "undefined" || !locale) return;
	overwriteGetLocale(() => locale);
}

/** The choice cookie in a `document.cookie`-style string, if it names a locale. */
export function localeFromCookieHeader(header: string | null | undefined, pseudo = false) {
	for (const part of (header ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === LOCALE_COOKIE) {
			try {
				return parseLocale(decodeURIComponent(part.slice(eq + 1).trim()), pseudo);
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/**
 * Remember an explicit choice in this browser. A signed-in person's choice is
 * also saved in their settings (which wins over this), so the cookie is what a
 * signed-out session, and the first paint after a sign-out, fall back on.
 * Blocked cookies are a smaller loss than a selector that throws.
 */
export function rememberLocaleCookie(locale: Locale): void {
	try {
		document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
	} catch {
		// See above.
	}
}

/**
 * A locale's own name for itself ("English", "Italiano"), for the selector.
 * Each language is written in that language, so a person who landed on the
 * wrong one can still find theirs. Falls back to the tag.
 */
export function localeLabel(locale: string): string {
	try {
		const name = new Intl.DisplayNames([intlTag(locale)], { type: "language" }).of(intlTag(locale));
		return name ? name.charAt(0).toLocaleUpperCase(intlTag(locale)) + name.slice(1) : locale;
	} catch {
		return locale;
	}
}

function intlTag(locale: string): string {
	return PSEUDO_LOCALES.includes(locale) ? (locale.split("-")[0] ?? locale) : locale;
}
