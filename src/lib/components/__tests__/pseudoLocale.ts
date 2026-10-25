/**
 * Helpers for the "every word comes from the catalogue" test each converted
 * screen carries: render the screen in the `en-XA` pseudo-locale (every message
 * is wrapped in brackets), then fail on any visible text that is not.
 *
 * A word that is not bracketed is one the template spells out itself, which no
 * translation could ever reach. Dynamic data (a chat's title, a file's name)
 * is not the catalogue's; tests pass `allow` for the few such lines they show.
 */
import { overwriteGetLocale } from "$lib/paraglide/runtime.js";

const WORDS = /[A-Za-z]{3,}/;
const ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];

export function usePseudoLocale(): void {
	overwriteGetLocale(() => "en-XA");
}

/** Back to English, for `afterEach`. */
export function useEnglish(): void {
	overwriteGetLocale(() => "en");
}

/**
 * Visible text lines and text-bearing attributes that carry words but no
 * brackets. `allow` takes each offending string and returns true for the ones
 * that are data (a name, a title, a number with its unit).
 */
export function unbracketed(
	allow: (text: string) => boolean = () => false,
	root: HTMLElement = document.body
): string[] {
	const found: string[] = [];
	const check = (text: string) => {
		const value = text.trim();
		if (WORDS.test(value) && !value.includes("[") && !allow(value)) found.push(value);
	};
	for (const line of root.innerText.split("\n")) check(line);
	for (const element of root.querySelectorAll("*")) {
		for (const name of ATTRIBUTES) {
			const value = element.getAttribute(name);
			if (value) check(value);
		}
	}
	return found;
}
