/** The longest a fallback title gets, in words. */
export const FALLBACK_MAX_WORDS = 6;

/** The longest a fallback title gets, in characters (text without spaces, e.g. CJK, has no words to count). */
const FALLBACK_MAX_CHARS = 48;

/**
 * Words that cannot end a title: articles, prepositions and conjunctions
 * (English and Italian). "Cosa puoi fare per" reads as cut off; "Cosa puoi
 * fare" does not.
 */
const FUNCTION_WORDS = new Set(
	[
		// English
		"a",
		"an",
		"the",
		"to",
		"of",
		"for",
		"in",
		"on",
		"at",
		"by",
		"with",
		"from",
		"about",
		"into",
		"and",
		"or",
		"but",
		"that",
		"which",
		"is",
		"are",
		"be",
		"as",
		"if",
		"so",
		"my",
		"your",
		"our",
		// Italian
		"il",
		"lo",
		"la",
		"i",
		"gli",
		"le",
		"un",
		"uno",
		"una",
		"di",
		"da",
		"su",
		"per",
		"con",
		"tra",
		"fra",
		"in",
		"del",
		"dello",
		"della",
		"dei",
		"degli",
		"delle",
		"al",
		"allo",
		"alla",
		"ai",
		"agli",
		"alle",
		"dal",
		"dalla",
		"nel",
		"nello",
		"nella",
		"nei",
		"nelle",
		"sul",
		"sulla",
		"e",
		"ed",
		"o",
		"ma",
		"che",
		"se",
		"come",
		"mio",
		"mia",
		"tuo",
		"tua",
	].map((w) => w.toLowerCase())
);

const bare = (word: string) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/**
 * The title used when no model could write one: the first sentence, cut at a
 * word boundary to at most six words, without trailing function words, and
 * ending in an ellipsis when something was cut. A short sentence is kept whole.
 */
export function fallbackTitle(prompt: string): string {
	const text = prompt.replace(/\s+/g, " ").trim();
	if (!text) return "New Chat";

	// First sentence: up to the first terminator followed by a space or the end.
	const sentence = /^.*?[.!?…](?=\s|$)/u.exec(text)?.[0] ?? text;
	const words = sentence.split(" ");

	if (words.length <= FALLBACK_MAX_WORDS && sentence.length <= FALLBACK_MAX_CHARS) {
		// A whole short sentence stays as written, minus a closing full stop.
		return sentence.replace(/[.…]+$/u, "") || sentence;
	}

	const kept = words.slice(0, FALLBACK_MAX_WORDS);
	// Never strip the title down to nothing.
	while (kept.length > 1 && FUNCTION_WORDS.has(bare(kept[kept.length - 1] ?? ""))) kept.pop();
	let out = kept.join(" ").replace(/[\s,;:.!?…-]+$/u, "");
	if (out.length > FALLBACK_MAX_CHARS) {
		// Cut at a word boundary when there is one, else mid-word (no spaces, e.g. CJK).
		out =
			out.slice(0, FALLBACK_MAX_CHARS).replace(/\s\S*$/u, "") || out.slice(0, FALLBACK_MAX_CHARS);
	}
	return `${out}…`;
}
