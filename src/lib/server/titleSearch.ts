/**
 * A title search that ignores case and accents, as one MongoDB regex.
 *
 * Mongo cannot do this natively for a substring match: a collation folds case
 * and diacritics for comparisons and sorts, but `$regex` never consults it. So
 * the folding is done here, in the pattern — each letter becomes a class of its
 * accented and cased variants, followed by any combining marks, which also
 * matches a title stored decomposed (`e` + U+0301). The class lists both cases
 * itself rather than leaning on the `i` flag, whose reach over non-ASCII
 * letters depends on how the server's PCRE was built.
 *
 * Everything else the person typed is escaped, so `c++` and `(draft` are
 * searched for, not interpreted. A search is a regex scan of the caller's own
 * titles whatever the pattern, so the length is capped to keep the pattern
 * cheap to compile and to run.
 */

import { MAX_TITLE_QUERY_LENGTH } from "$lib/constants/pagination";

const COMBINING_MARKS = /[\u0300-\u036f]/g;
// The characters themselves, not a `\u` escape: PCRE has no such escape.
const MARKS_CLASS = "[\u0300-\u036f]*";

/** Letters with no canonical decomposition, folded by hand. */
const EXTRA_BASES: Record<string, string> = {
	ł: "l",
	ø: "o",
	đ: "d",
	ð: "d",
	ħ: "h",
	ı: "i",
};

const baseOf = (char: string): string =>
	EXTRA_BASES[char.toLowerCase()] ?? char.normalize("NFD").replace(COMBINING_MARKS, "");

/** Base letter (lower case) → every cased and accented form of it. */
const variants: Map<string, Set<string>> = (() => {
	const map = new Map<string, Set<string>>();
	const add = (char: string) => {
		const base = baseOf(char).toLowerCase();
		if (base.length !== 1 || !/[a-z]/.test(base)) return;
		const set = map.get(base) ?? new Set<string>([base, base.toUpperCase()]);
		set.add(char.toLowerCase());
		set.add(char.toUpperCase());
		map.set(base, set);
	};
	for (let code = 0x41; code <= 0x7a; code++) add(String.fromCharCode(code));
	// Latin-1 Supplement, Latin Extended-A and -B, Latin Extended Additional.
	for (const [from, to] of [
		[0xc0, 0x24f],
		[0x1e00, 0x1eff],
	]) {
		for (let code = from; code <= to; code++) add(String.fromCharCode(code));
	}
	for (const char of Object.keys(EXTRA_BASES)) add(char);
	return map;
})();

const escapeChar = (char: string): string => char.replace(/[.*+?^${}()|[\]\\\-/]/g, "\\$&");

/**
 * The pattern for `query`, or `null` when there is nothing to search for
 * (empty, or only whitespace), which the caller treats as "no filter".
 */
export function titleSearchPattern(query: string): string | null {
	const trimmed = query.trim().slice(0, MAX_TITLE_QUERY_LENGTH).trim();
	if (!trimmed) return null;

	let pattern = "";
	let inSpace = false;
	// Per code point, so an emoji is one unit rather than two broken halves.
	for (const char of trimmed.normalize("NFC")) {
		if (/\s/.test(char)) {
			if (!inSpace) pattern += "\\s+";
			inSpace = true;
			continue;
		}
		inSpace = false;
		const set = variants.get(baseOf(char).toLowerCase());
		if (set && baseOf(char).length === 1) {
			pattern += `[${[...set].join("")}]${MARKS_CLASS}`;
		} else {
			pattern += escapeChar(char);
		}
	}
	return pattern;
}
