/**
 * Size bounds for tool results. galopin cannot carry a message over 1 MiB to Cerea (it answers
 * "response too large" and the run ends), so no result leaves the runtime above RESULT_LIMIT
 * bytes. A JSON result is sent twice (as `structuredContent` and as a text block), so the
 * per-tool budgets below count each copy at half of what is left.
 */

import type { Diff, ExtractResult, Snapshot } from "./contract.ts";

/** The most bytes of one whole tool result (all content blocks, as JSON). */
export const RESULT_LIMIT = 900_000;
/** The most bytes of one JSON payload; it travels twice, plus a little framing. */
export const PAYLOAD_LIMIT = 400_000;
/** The most base64 characters of one screenshot. */
export const SCREENSHOT_LIMIT = 700_000;

export const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

const SNAPSHOT_NOTE =
	"[truncated: this page is larger than one result can carry. Scroll to the part you need, use extract for tables and lists, or narrow down with a smaller region.]";

/** Cuts text at a line end so that at most `max` bytes remain. */
function cutText(text: string, max: number): string {
	if (Buffer.byteLength(text) <= max) return text;
	let cut = text.slice(0, Math.max(0, max));
	while (Buffer.byteLength(cut) > max) cut = cut.slice(0, Math.floor(cut.length * 0.9));
	const nl = cut.lastIndexOf("\n");
	return nl > max * 0.5 ? cut.slice(0, nl) : cut;
}

/** A snapshot within `budget` bytes: the tail of the tree and its elements dropped, with a note. */
export function boundSnapshot(s: Snapshot, budget = PAYLOAD_LIMIT): Snapshot {
	if (bytesOf(s) <= budget) return s;
	const elements = [...s.elements];
	let text = s.text;
	let out: Snapshot = s;
	for (let guard = 0; guard < 40; guard++) {
		out = { ...s, text, elements, truncated: true, note: SNAPSHOT_NOTE } as Snapshot;
		if (bytesOf(out) <= budget) return out;
		// Halve whichever part is bigger, until it fits.
		if (Buffer.byteLength(text) >= bytesOf(elements)) {
			text = cutText(text, Math.floor(Buffer.byteLength(text) * 0.7));
		} else {
			elements.length = Math.floor(elements.length * 0.7);
		}
	}
	return out;
}

/** A diff within `budget` bytes, its nested snapshot included. */
export function boundDiff(d: Diff, budget = PAYLOAD_LIMIT): Diff {
	if (bytesOf(d) <= budget) return d;
	let out: Diff = { ...d };
	if (out.snapshot) out = { ...out, snapshot: boundSnapshot(out.snapshot, Math.floor(budget / 2)) };
	const added = [...out.added];
	const changed = [...out.changed];
	const removed = [...out.removed];
	let text = out.text;
	for (let guard = 0; guard < 40; guard++) {
		const next = {
			...out,
			added,
			changed,
			removed,
			text: `${text}\n${SNAPSHOT_NOTE}`,
			truncated: true,
		} as Diff;
		if (bytesOf(next) <= budget) return next;
		added.length = Math.floor(added.length * 0.7);
		changed.length = Math.floor(changed.length * 0.7);
		removed.length = Math.floor(removed.length * 0.7);
		text = cutText(text, Math.floor(Buffer.byteLength(text) * 0.7));
	}
	return {
		...out,
		added: [],
		changed: [],
		removed: [],
		text: SNAPSHOT_NOTE,
		truncated: true,
	} as Diff;
}

/** An extract within `budget` bytes: rows and items cut from the tails, counted in `truncated`. */
export function boundExtract(e: ExtractResult, budget = PAYLOAD_LIMIT): ExtractResult {
	if (bytesOf(e) <= budget) return e;
	const tables = e.tables.map((t) => ({ ...t, rows: [...t.rows] }));
	const lists = e.lists.map((l) => ({ ...l, items: [...l.items] }));
	let text = e.text;
	const note =
		"Cut to fit one result: rows and items past the cut are counted in truncated. Narrow down with a ref, or scroll and extract again.";
	const build = (): ExtractResult => ({
		...e,
		tables: tables.map((t, i) => ({
			...t,
			...(e.tables[i].rows.length + (e.tables[i].truncated ?? 0) > t.rows.length
				? { truncated: e.tables[i].rows.length + (e.tables[i].truncated ?? 0) - t.rows.length }
				: {}),
		})),
		lists: lists.map((l, i) => ({
			...l,
			...(e.lists[i].items.length + (e.lists[i].truncated ?? 0) > l.items.length
				? { truncated: e.lists[i].items.length + (e.lists[i].truncated ?? 0) - l.items.length }
				: {}),
		})),
		...(text !== undefined ? { text } : {}),
		note,
	});
	for (let guard = 0; guard < 200; guard++) {
		const out = build();
		if (bytesOf(out) <= budget) return out;
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
