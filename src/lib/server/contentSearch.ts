/**
 * What message-content search on `/chats` needs besides the index: reading the
 * query, and cutting a short snippet out of the conversation a hit came from.
 *
 * The query is MongoDB's `$text` syntax: words (any of them), `"a phrase"`,
 * `-excluded`. Matching in the snippet mirrors that loosely — whole words and
 * phrases, ignoring case and accents — so the span shown highlighted is what
 * the index matched. A conversation whose hit the snippet cannot find (a title
 * hit, say) simply has no snippet.
 */

import { MAX_TITLE_QUERY_LENGTH } from "$lib/constants/pagination";

export interface ContentSnippet {
	/** Message text around the first match, markdown roughly stripped. */
	text: string;
	/** Matched ranges in `text`, as [start, end) UTF-16 offsets, in order. */
	spans: [number, number][];
	from: "user" | "assistant";
	messageId: string;
}

export const SNIPPET_LENGTH = 160;
/** All the text `buildSnippet` will read for one conversation, however many messages. */
/** What the list query hands `buildSnippet`: at most this many messages, this many characters each. */
export const SNIPPET_MESSAGES = 300;
export const SNIPPET_MESSAGE_CHARS = 3000;
export const MAX_TOTAL_SCAN = 200_000;
/** Only this much of one message is searched for a snippet. */
const MAX_SCAN = 40_000;

const MARKS = /[̀-ͯ]/g;
const EXTRA: Record<string, string> = { ł: "l", ø: "o", đ: "d", ð: "d", ħ: "h", ı: "i", ß: "ss" };
const COMBINING = /^[\u0300-\u036f]$/;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Lower-case, accent-free form of one character (possibly several characters). */
const fold = (char: string): string =>
	EXTRA[char.toLowerCase()] ?? char.normalize("NFD").replace(MARKS, "").toLowerCase();

const foldText = (text: string): string => [...text].map(fold).join("");

/** The terms of a `$text` query: its quoted phrases and words, minus `-negated` ones, folded. */
export function queryTerms(query: string): string[] {
	const terms: string[] = [];
	for (const match of query
		.slice(0, MAX_TITLE_QUERY_LENGTH)
		.matchAll(/(-?)"([^"]*)"?|(-?)(\S+)/g)) {
		const negated = (match[1] || match[3]) === "-";
		const raw = match[2] ?? match[4] ?? "";
		const term = foldText(raw).replace(/\s+/g, " ").trim();
		if (!negated && term) terms.push(term);
	}
	return [...new Set(terms)];
}

const isWhole = (term: string): boolean => [...term].filter((c) => WORD_CHAR.test(c)).length >= 2;

/**
 * The query as MongoDB should read it. Bare `$text` words mean "any of them";
 * a search for `codice fiscale` should find chats that have both, so each word
 * is quoted (a quoted term must be present) and phrases and `-negations` are
 * kept as typed. A quoted term is also matched inside longer words (`art`
 * finds "category"). Terms with fewer than two letters or digits are dropped:
 * a one-letter word matches nearly every chat.
 */
export function textSearchString(query: string): string {
	const parts: string[] = [];
	for (const match of query
		.slice(0, MAX_TITLE_QUERY_LENGTH)
		.matchAll(/(-?)"([^"]*)"?|(-?)(\S+)/g)) {
		const negated = (match[1] || match[3]) === "-";
		const raw = (match[2] ?? match[4] ?? "").replace(/"/g, " ").trim();
		if (!raw || !isWhole(raw)) continue;
		parts.push(negated ? `-"${raw}"` : `"${raw}"`);
	}
	return parts.join(" ");
}

/** Whether content search has something to do: a term of at least two letters or digits. */
export function hasWholeWord(query: string): boolean {
	return queryTerms(query).some(isWhole);
}

/** Markdown reduced to the words: no fences, markers, link targets or images. */
export function stripMarkdown(text: string): string {
	return text
		.replace(/```[^\n]*\n?/g, " ")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
		.replace(/[*_`~|]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Folded text with, for each folded character, the offset it came from in the original. */
function foldWithMap(text: string): { folded: string; origin: number[]; end: number[] } {
	let folded = "";
	const origin: number[] = [];
	const end: number[] = [];
	let at = 0;
	for (const char of text) {
		const f = fold(char);
		if (f === "" && COMBINING.test(char) && end.length) {
			// A combining mark belongs to the letter before it, so a match ends after it.
			for (let k = end.length - 1; k >= 0 && end[k] === at; k--) end[k] = at + char.length;
			at += char.length;
			continue;
		}
		for (let i = 0; i < f.length; i++) {
			origin.push(at);
			end.push(at + char.length);
		}
		folded += f;
		at += char.length;
	}
	return { folded, origin, end };
}

/** Whole-word occurrences of each term in `folded`, as [start, end) folded offsets. */
function occurrences(folded: string, terms: string[]): [number, number][] {
	const found: [number, number][] = [];
	for (const term of terms) {
		let from = 0;
		for (;;) {
			const at = folded.indexOf(term, from);
			if (at < 0) break;
			const stop = at + term.length;
			const before = at === 0 || !WORD_CHAR.test(folded[at - 1]);
			const after = stop >= folded.length || !WORD_CHAR.test(folded[stop]);
			if (before && after) found.push([at, stop]);
			from = at + 1;
		}
	}
	return found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
}

/**
 * The snippet for the first user or assistant message that holds a term of
 * `query`, or `undefined` when none does.
 */
export function buildSnippet(
	messages: { id: string; from: string; content?: string }[] | undefined,
	query: string
): ContentSnippet | undefined {
	const terms = queryTerms(query);
	if (!terms.length || !messages) return undefined;
	let budget = MAX_TOTAL_SCAN;
	for (const message of messages) {
		if (budget <= 0) break;
		if (message.from !== "user" && message.from !== "assistant") continue;
		if (typeof message.content !== "string" || !message.content) continue;
		const piece = message.content.slice(0, Math.min(MAX_SCAN, budget));
		budget -= piece.length;
		const text = stripMarkdown(piece);
		const { folded, origin, end } = foldWithMap(text);
		const hits = occurrences(folded, terms);
		if (!hits.length) continue;

		const first = origin[hits[0][0]];
		const lastEnd = end[hits[0][1] - 1];
		// Centre the first match, then pull the edges in to word boundaries.
		const room = Math.max(0, SNIPPET_LENGTH - (lastEnd - first));
		let start = Math.max(0, first - Math.floor(room / 3));
		let stop = Math.min(text.length, start + SNIPPET_LENGTH);
		start = Math.max(0, Math.min(start, stop - SNIPPET_LENGTH));
		if (start > 0) {
			const space = text.indexOf(" ", start);
			if (space >= 0 && space < first) start = space + 1;
		}
		if (stop < text.length) {
			const space = text.lastIndexOf(" ", stop);
			if (space > lastEnd) stop = space;
		}
		const body = text.slice(start, stop);
		const lead = start > 0 ? "… " : "";
		const tail = stop < text.length ? " …" : "";
		const shift = lead.length - start;

		const spans: [number, number][] = [];
		for (const [a, b] of hits) {
			const s = origin[a];
			const e = end[b - 1];
			if (s < start || e > stop) continue;
			const prev = spans.at(-1);
			if (prev && s + shift < prev[1]) {
				prev[1] = Math.max(prev[1], e + shift);
				continue;
			}
			spans.push([s + shift, e + shift]);
		}
		return {
			text: lead + body + tail,
			spans,
			from: message.from,
			messageId: message.id,
		};
	}
	return undefined;
}
