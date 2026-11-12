/**
 * Model-free extraction: tables and lists to JSON rows, and the text of a region. The runtime has
 * no model, so it never maps data onto a schema; it returns what is on the page, structured, and
 * the browse sub-agent does the mapping.
 */

import type { ExtractResult } from "./contract.ts";
import { clean, cleanMultiline } from "./sanitize.ts";

export type ExtractMode = "auto" | "tables" | "lists" | "text";

export interface ExtractOptions {
	mode: ExtractMode;
	maxRows: number;
	maxItems: number;
	maxText: number;
}

export interface RawTable {
	caption: string;
	headers: string[];
	rows: Array<{ cells: string[]; links: Array<{ text: string; href: string }> }>;
	total: number;
}
export interface RawList {
	label: string;
	kind: "list" | "definitions";
	items: string[];
	definitions: Array<{ term: string; definition: string }>;
	total: number;
}
export interface RawExtract {
	tables: RawTable[];
	lists: RawList[];
	text: string;
	rootTag: string;
}

/**
 * Runs inside the page, with `root` as the region. Plain function: it is serialised and sent to
 * the browser, so it uses nothing from this module.
 */
export function pageExtract(
	root: Element,
	opts: { mode: ExtractMode; maxRows: number; maxItems: number; maxText: number; whole: boolean }
): RawExtract {
	const visible = (el: Element) => {
		const style = getComputedStyle(el);
		return (
			style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0
		);
	};
	const txt = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();
	const within = (selector: string): Element[] => {
		const found = Array.from(root.querySelectorAll(selector));
		if (root.matches(selector)) found.unshift(root);
		return found;
	};
	const wantTables = opts.mode === "auto" || opts.mode === "tables";
	const wantLists = opts.mode === "auto" || opts.mode === "lists";
	const tables: RawTable[] = [];
	const lists: RawList[] = [];

	if (wantTables) {
		for (const table of within("table, [role=table], [role=grid]")) {
			if (!visible(table) || tables.length >= 20) continue;
			const rowEls = Array.from(table.querySelectorAll("tr, [role=row]")).filter(
				(r) => r.closest("table, [role=table], [role=grid]") === table
			);
			if (rowEls.length === 0) continue;
			const cellsOf = (row: Element) =>
				Array.from(
					row.querySelectorAll(
						"th, td, [role=cell], [role=gridcell], [role=columnheader], [role=rowheader]"
					)
				).filter((c) => c.closest("tr, [role=row]") === row);
			let headerRow = rowEls.find(
				(r) =>
					cellsOf(r).length > 0 &&
					cellsOf(r).every((c) => c.tagName === "TH" || c.getAttribute("role") === "columnheader")
			);
			if (!headerRow) headerRow = undefined;
			const headers = headerRow ? cellsOf(headerRow).map(txt) : [];
			const bodyRows = rowEls.filter((r) => r !== headerRow && cellsOf(r).length > 0);
			const caption =
				table.querySelector("caption")?.textContent ?? table.getAttribute("aria-label") ?? "";
			tables.push({
				caption,
				headers,
				total: bodyRows.length,
				rows: bodyRows.slice(0, opts.maxRows).map((row) => ({
					cells: cellsOf(row).map(txt),
					links: Array.from(row.querySelectorAll("a[href]"))
						.slice(0, 5)
						.map((a) => ({
							text: txt(a),
							href: (a as HTMLAnchorElement).getAttribute("href") ?? "",
						})),
				})),
			});
		}
	}
	if (wantLists) {
		for (const list of within("ul, ol, [role=list]")) {
			if (!visible(list) || lists.length >= 20 || list.closest("table, nav, [role=navigation]"))
				continue;
			const items = Array.from(list.children).filter(
				(c) => c.tagName === "LI" || c.getAttribute("role") === "listitem"
			);
			if (items.length < 2) continue;
			lists.push({
				label: list.getAttribute("aria-label") ?? "",
				kind: "list",
				total: items.length,
				items: items.slice(0, opts.maxItems).map(txt),
				definitions: [],
			});
		}
		for (const dl of within("dl")) {
			if (!visible(dl) || lists.length >= 20) continue;
			const definitions: Array<{ term: string; definition: string }> = [];
			let term = "";
			for (const child of Array.from(dl.children)) {
				if (child.tagName === "DT") term = txt(child);
				else if (child.tagName === "DD") definitions.push({ term, definition: txt(child) });
			}
			if (definitions.length === 0) continue;
			lists.push({
				label: dl.getAttribute("aria-label") ?? "",
				kind: "definitions",
				total: definitions.length,
				items: [],
				definitions: definitions.slice(0, opts.maxItems),
			});
		}
	}
	let text = "";
	if (opts.mode === "text" || (opts.mode === "auto" && !opts.whole)) {
		text = txt(root).slice(0, opts.maxText * 2);
	}
	return { tables, lists, text, rootTag: root.tagName.toLowerCase() };
}

/** Header names made unique and never empty, so each row can be an object. */
function headerNames(headers: string[], width: number): string[] {
	const seen = new Map<string, number>();
	return Array.from({ length: width }, (_, i) => {
		const base = clean(headers[i] ?? "", 80) || `column${i + 1}`;
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		return count === 1 ? base : `${base}_${count}`;
	});
}

export function shapeExtract(
	raw: RawExtract,
	opts: ExtractOptions,
	wantText: boolean
): ExtractResult {
	const tables = raw.tables.map((t) => {
		const width = Math.max(t.headers.length, ...t.rows.map((r) => r.cells.length), 0);
		const names = headerNames(t.headers, width);
		return {
			...(t.caption ? { caption: clean(t.caption, 300) } : {}),
			headers: t.headers.length > 0 ? names : [],
			rows: t.rows.map((row) =>
				Array.from({ length: width }, (_, i) => clean(row.cells[i] ?? "", 2000))
			),
			...(t.total > t.rows.length ? { truncated: t.total - t.rows.length } : {}),
		};
	});
	const lists = raw.lists.map((l) => {
		const items =
			l.kind === "definitions"
				? l.definitions.map((d) => clean(`${d.term}: ${d.definition}`, 2000))
				: l.items.map((i) => clean(i, 2000));
		return { items, ...(l.total > items.length ? { truncated: l.total - items.length } : {}) };
	});
	const text = wantText ? cleanMultiline(raw.text, opts.maxText) : "";
	return { tables, lists, ...(text ? { text } : {}) };
}
