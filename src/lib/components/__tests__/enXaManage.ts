/**
 * Helpers for the "renders in en-XA" tests of the manage screens (projects,
 * admin, models, skills, knowledge, memory): put the page in the pseudo-locale,
 * then list every visible word the catalogue does not own.
 *
 * In en-XA every catalogue message is wrapped in brackets, so a visible line (or
 * a `title` / `placeholder` / `aria-label` value) with three letters in a row and
 * no bracket is hard-coded. What a person typed or the API sent is not words to
 * translate: a test names those values in `allow`.
 */
import { overwriteGetLocale } from "$lib/paraglide/runtime.js";

export const usePseudoLocale = () => overwriteGetLocale(() => "en-XA");
export const useEnglish = () => overwriteGetLocale(() => "en");

const HAS_WORD = /[A-Za-z]{3,}/;

/**
 * Not this slice's words: the shared `Switch` names itself `aria-label="switch"`
 * (a role description, outside the screens converted here).
 */
const SHARED = [/^switch$/];

export function unbracketedWords(allow: ReadonlyArray<string | RegExp> = []): string[] {
	const allowed = (line: string) =>
		[...SHARED, ...allow].some((entry) =>
			typeof entry === "string" ? line.includes(entry) : entry.test(line)
		);
	const lines = document.body.innerText.split("\n").map((line) => line.trim());
	const attributes = [
		...document.body.querySelectorAll<HTMLElement>("[aria-label],[placeholder],[title]"),
	].flatMap((element) =>
		["aria-label", "placeholder", "title"].flatMap((name) => element.getAttribute(name) ?? [])
	);
	return [...lines, ...attributes]
		.filter((line) => HAS_WORD.test(line) && !line.includes("[") && !allowed(line))
		.filter((line, index, all) => all.indexOf(line) === index);
}
