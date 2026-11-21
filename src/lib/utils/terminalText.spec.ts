import { describe, expect, it } from "vitest";
import { bufferToText, type TextBuffer } from "./terminalText";

/** rows: [text, wrapped?]; text is the untrimmed cell content. */
function fakeBuffer(rows: Array<[string, boolean?]>): TextBuffer {
	return {
		length: rows.length,
		getLine: (y) =>
			rows[y]
				? {
						isWrapped: rows[y][1] ?? false,
						translateToString: (trim) => (trim ? rows[y][0].replace(/\s+$/, "") : rows[y][0]),
					}
				: undefined,
	};
}

describe("bufferToText", () => {
	it("joins rows with newlines and trims trailing spaces", () => {
		expect(bufferToText(fakeBuffer([["$ ls   "], ["a b    "]]))).toBe("$ ls\na b");
	});

	it("trims spaces that were written to the cells (xterm keeps those as content)", () => {
		const buf = fakeBuffer([["a   "], ["b"], ["   "]]);
		const padded: TextBuffer = {
			length: 3,
			getLine: (y) => ({ isWrapped: false, translateToString: () => ["a   ", "b", "   "][y] }),
		};
		expect(bufferToText(padded)).toBe("a\nb");
		expect(bufferToText(buf)).toBe("a\nb");
	});

	it("joins wrapped rows into one logical line", () => {
		const buf = fakeBuffer([["abcdef"], ["ghijkl", true], ["mn   ", true], ["next"]]);
		expect(bufferToText(buf)).toBe("abcdefghijklmn\nnext");
	});

	it("drops the empty rows below the last output but keeps blank lines between", () => {
		expect(bufferToText(fakeBuffer([["a"], [""], ["b"], [""], [""]]))).toBe("a\n\nb");
	});

	it("includes scrollback (rows above the viewport) by default", () => {
		const rows: Array<[string]> = Array.from({ length: 100 }, (_, i) => [`line ${i}`]);
		const text = bufferToText(fakeBuffer(rows));
		expect(text.split("\n")).toHaveLength(100);
		expect(text.startsWith("line 0\n")).toBe(true);
	});

	it("reads only the visible screen with startRow/endRow", () => {
		const rows: Array<[string]> = Array.from({ length: 10 }, (_, i) => [`l${i}`]);
		expect(bufferToText(fakeBuffer(rows), { startRow: 7, endRow: 10 })).toBe("l7\nl8\nl9");
	});

	it("keeps only the last maxLines logical lines", () => {
		const rows: Array<[string, boolean?]> = [["a"], ["b"], ["c1"], ["c2", true], ["d"]];
		expect(bufferToText(fakeBuffer(rows), { maxLines: 2 })).toBe("c1c2\nd");
	});

	it("is empty for an empty buffer", () => {
		expect(bufferToText(fakeBuffer([]))).toBe("");
	});
});
