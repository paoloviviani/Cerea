/**
 * Size bounds for tool results. galopin cannot carry a message over 1 MiB to Cerea (it answers
 * "response too large" and the run ends), so no result leaves the runtime above RESULT_LIMIT
 * bytes. Every bound below is measured on the real wire size: the whole tool result as the server
 * sends it (a JSON result travels twice, as `structuredContent` and as an escaped text block),
 * which the caller supplies as `measure`.
 */

import type { Diff, ExtractResult, Snapshot } from "./contract.ts";
import { CONTENT_TAG } from "./sanitize.ts";

/** The most bytes of one whole tool result (all content blocks, as JSON). */
export const RESULT_LIMIT = 900_000;
/** What the per-tool bounds aim for on the wire: a margin under RESULT_LIMIT. */
export const WIRE_BUDGET = 700_000;
/** The most base64 characters of one screenshot. */
export const SCREENSHOT_LIMIT = 700_000;
/** The most base64 characters of the files of one `download` result (they travel twice). */
export const DOWNLOAD_BASE64_LIMIT = 300_000;

/** The size of a value on the wire. */
export type Measure = (value: object) => number;

export const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

export const SNAPSHOT_NOTE =
	"[truncated: this page is larger than one result can carry. Scroll to the part you need, use extract for tables and lists, or narrow down with a smaller region.]";

const CLOSE = `</${CONTENT_TAG}>`;

/** Cuts text at a line end so that at most `max` bytes remain; a closing fence tag is kept. */
function cutText(text: string, max: number): string {
	if (Buffer.byteLength(text) <= max) return text;
	const closed = text.endsWith(CLOSE);
	const body = closed ? text.slice(0, -CLOSE.length).trimEnd() : text;
	const room = Math.max(0, max - (closed ? CLOSE.length + 1 : 0));
	let cut = body.slice(0, room);
	while (Buffer.byteLength(cut) > room) cut = cut.slice(0, Math.floor(cut.length * 0.9));
	const nl = cut.lastIndexOf("\n");
	if (nl > room * 0.5) cut = cut.slice(0, nl);
	return closed ? `${cut}\n${CLOSE}` : cut;
}

/** The note goes first, where a clip of the end of the text cannot take it. */
const withNote = (text: string) => `${SNAPSHOT_NOTE}\n${text}`;

/** A snapshot within `budget` bytes on the wire: the tail of the tree and its elements dropped. */
export function boundSnapshot(s: Snapshot, measure: Measure, budget = WIRE_BUDGET): Snapshot {
	if (measure(s) <= budget) return s;
	const elements = [...s.elements];
	let base = s.text;
	let out: Snapshot = s;
	for (let guard = 0; guard < 60; guard++) {
		out = { ...s, text: withNote(base), elements, truncated: true, note: SNAPSHOT_NOTE };
		if (measure(out) <= budget) return out;
		// Cut whichever part is bigger.
		if (Buffer.byteLength(base) >= bytesOf(elements)) {
			base = cutText(base, Math.floor(Buffer.byteLength(base) * 0.7));
		} else {
			elements.length = Math.floor(elements.length * 0.7);
		}
	}
	return { ...s, text: withNote(""), elements: [], truncated: true, note: SNAPSHOT_NOTE };
}

/** A diff within `budget` bytes on the wire, its nested snapshot included. */
export function boundDiff(d: Diff, measure: Measure, budget = WIRE_BUDGET): Diff {
	if (measure(d) <= budget) return d;
	let out: Diff = { ...d };
	if (out.snapshot) {
		const snapshot = boundSnapshot(out.snapshot, measure, Math.floor(budget * 0.4));
		out = { ...out, snapshot, text: snapshot.text };
	}
	const added = [...out.added];
	const changed = [...out.changed];
	const removed = [...out.removed];
	let base = out.text;
	for (let guard = 0; guard < 60; guard++) {
		const next: Diff = {
			...out,
			added,
			changed,
			removed,
			text: out.snapshot && out.snapshot.text === out.text ? out.text : withNote(base),
			truncated: true,
		};
		if (measure(next) <= budget) return next;
		added.length = Math.floor(added.length * 0.7);
		changed.length = Math.floor(changed.length * 0.7);
		removed.length = Math.floor(removed.length * 0.7);
		if (out.snapshot) {
			const snapshot = boundSnapshot(
				out.snapshot,
				measure,
				Math.floor(budget * (0.4 * 0.7 ** guard))
			);
			out = { ...out, snapshot, text: snapshot.text };
			base = out.text;
		} else {
			base = cutText(base, Math.floor(Buffer.byteLength(base) * 0.7));
		}
	}
	return { ...out, added: [], changed: [], removed: [], text: withNote(""), truncated: true };
}

/** An extract within `budget` bytes on the wire: rows and items cut from the tails, counted in `truncated`. */
export function boundExtract(
	e: ExtractResult,
	measure: Measure,
	budget = WIRE_BUDGET
): ExtractResult {
	if (measure(e) <= budget) return e;
	const tables = e.tables.map((t) => ({ ...t, rows: [...t.rows] }));
	const lists = e.lists.map((l) => ({ ...l, items: [...l.items] }));
	let text = e.text;
	const note =
		"Cut to fit one result: rows and items past the cut are counted in truncated. Narrow down with a ref, or scroll and extract again.";
	const build = (): ExtractResult => ({
		note,
		...e,
		tables: tables.map((t, i) => {
			const total = e.tables[i].rows.length + (e.tables[i].truncated ?? 0);
			return { ...t, ...(total > t.rows.length ? { truncated: total - t.rows.length } : {}) };
		}),
		lists: lists.map((l, i) => {
			const total = e.lists[i].items.length + (e.lists[i].truncated ?? 0);
			return { ...l, ...(total > l.items.length ? { truncated: total - l.items.length } : {}) };
		}),
		...(text !== undefined ? { text } : {}),
	});
	for (let guard = 0; guard < 200; guard++) {
		const out = build();
		if (measure(out) <= budget) return out;
		// Cut the biggest part by a third.
		let biggest: { size: number; cut: () => void } | undefined;
		const consider = (size: number, cut: () => void) => {
			if (!biggest || size > biggest.size) biggest = { size, cut };
		};
		for (const t of tables)
			consider(bytesOf(t.rows), () => void (t.rows.length = Math.floor(t.rows.length * 0.67)));
		for (const l of lists)
			consider(bytesOf(l.items), () => void (l.items.length = Math.floor(l.items.length * 0.67)));
		if (text !== undefined)
			consider(
				Buffer.byteLength(text),
				() => void (text = cutText(text!, Math.floor(Buffer.byteLength(text!) * 0.67)))
			);
		if (!biggest || biggest.size < 50) break;
		biggest.cut();
	}
	return { ...build(), tables: [], lists: [], text: undefined };
}
