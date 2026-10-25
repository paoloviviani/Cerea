/**
 * What a screen shows that the catalogue does not own: every visible line of
 * text, and every `title`, `aria-label` and `placeholder`, that has words in it
 * and is not bracketed by the `en-XA` pseudo-locale. A test renders in `en-XA`,
 * then expects this to be empty (minus the few literals it names).
 */
const WORDS = /[A-Za-z]{3,}/;

export function unbracketedText(
	root: Element = document.body,
	allow: ReadonlyArray<RegExp | string> = []
): string[] {
	const allowed = (line: string) =>
		allow.some((item) => (typeof item === "string" ? line === item : item.test(line)));
	const lines = ((root as HTMLElement).innerText ?? root.textContent ?? "")
		.split("\n")
		.map((line) => line.trim());
	const attributes = [...root.querySelectorAll("[title], [aria-label], [placeholder]")].flatMap(
		(element) =>
			["title", "aria-label", "placeholder"].flatMap((name) => element.getAttribute(name) ?? [])
	);
	return [...lines, ...attributes]
		.filter((line) => WORDS.test(line) && !line.includes("["))
		.filter((line) => !allowed(line));
}
