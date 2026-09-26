/**
 * Minimal RFC-4180-style CSV parsing for `table` artifacts: the model emits
 * tabular data as CSV with a header row, and the panel grids it. No
 * third-party dependency — the grammar is small (commas, quotes, newlines)
 * and a hand parser keeps the bundle and the licence surface unchanged.
 *
 * Tolerant by design (model output, not machine output): CRLF/LF/CR line
 * endings, `""` escapes, embedded commas and newlines inside quoted fields,
 * junk after a closing quote, and an unterminated trailing quote (streaming
 * cut the content mid-field) all parse instead of throwing. Fully empty
 * lines are skipped so a trailing newline never becomes a phantom row.
 */

export interface ParsedCsvTable {
	header: string[];
	rows: string[][];
}

/** Rows the grid renders before capping with a "download for the rest" note. */
export const MAX_TABLE_RENDER_ROWS = 5000;

/** Parse one CSV document into rows of fields. Never throws. */
export function parseCsvRows(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let rowHasContent = false;
	// A byte-order mark is invisible in the panel but would otherwise become
	// the first header's first character.
	let i = text.startsWith("\uFEFF") ? 1 : 0;

	const pushField = () => {
		row.push(field);
		field = "";
	};

	const pushRow = () => {
		pushField();
		// Skip lines that carried nothing at all (blank lines, trailing
		// newline); a line of empty fields (`,,`) is real data and is kept.
		if (rowHasContent) rows.push(row);
		row = [];
		rowHasContent = false;
	};

	while (i < text.length) {
		const c = text[i];
		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
				} else {
					inQuotes = false;
					i += 1;
				}
			} else {
				field += c;
				i += 1;
			}
			continue;
		}
		if (c === '"') {
			// An opening quote only counts at a field start; a stray quote
			// mid-field is literal text, not a protocol error.
			if (field.length === 0) {
				inQuotes = true;
				rowHasContent = true;
			} else {
				field += c;
			}
			i += 1;
		} else if (c === ",") {
			rowHasContent = true;
			pushField();
			i += 1;
		} else if (c === "\r" || c === "\n") {
			pushRow();
			i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
		} else {
			// Whitespace never marks a row as content on its own, so a
			// whitespace-only line is skipped like a blank one; spaces
			// inside a real field are still kept verbatim.
			if (!/^\s$/.test(c)) rowHasContent = true;
			field += c;
			i += 1;
		}
	}
	// An unterminated quote means the stream was cut mid-field: keep what
	// arrived rather than dropping the row.
	pushRow();
	return rows;
}

/**
 * Split a table artifact's content into header + data rows. Returns null
 * when there is nothing to grid (empty content), so the panel can fall back
 * to the raw text. Short rows are padded with "" and long rows trimmed, so
 * every row lines up under the header.
 */
export function parseCsvTable(content: string): ParsedCsvTable | null {
	if (!content || !content.trim()) return null;
	const rows = parseCsvRows(content);
	if (rows.length === 0) return null;
	const header = rows[0];
	const rest = rows.slice(1);
	const width = header?.length ?? 0;
	if (!header || width === 0) return null;
	return {
		header,
		rows: rest.map((r) => {
			if (r.length === width) return r;
			if (r.length < width) return [...r, ...Array<string>(width - r.length).fill("")];
			return r.slice(0, width);
		}),
	};
}

/**
 * Header-click sorting: numeric when both cells parse as numbers (so "10"
 * sorts after "9"), locale-aware otherwise. Empty cells always sort last so
 * gaps sink instead of scattering.
 */
export function compareTableCells(a: string, b: string): number {
	const aEmpty = a.trim() === "";
	const bEmpty = b.trim() === "";
	if (aEmpty && bEmpty) return 0;
	if (aEmpty) return 1;
	if (bEmpty) return -1;
	const na = Number(a);
	const nb = Number(b);
	if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
		return na - nb;
	}
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Case-insensitive substring match across every cell of a row. */
export function rowMatchesQuery(row: string[], query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return row.some((cell) => cell.toLowerCase().includes(q));
}
