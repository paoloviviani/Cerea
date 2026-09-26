import { describe, expect, test } from "vitest";
import {
	compareTableCells,
	MAX_TABLE_RENDER_ROWS,
	parseCsvRows,
	parseCsvTable,
	rowMatchesQuery,
} from "./csv";

describe("parseCsvRows", () => {
	test("parses a simple header + rows", () => {
		expect(parseCsvRows("a,b,c\n1,2,3\n4,5,6")).toEqual([
			["a", "b", "c"],
			["1", "2", "3"],
			["4", "5", "6"],
		]);
	});

	test("handles quoted fields with embedded commas", () => {
		expect(parseCsvRows('"a,b",c\n"x",y')).toEqual([
			["a,b", "c"],
			["x", "y"],
		]);
	});

	test("handles embedded newlines inside quoted fields", () => {
		expect(parseCsvRows('a,b\n"line1\nline2",c')).toEqual([
			["a", "b"],
			["line1\nline2", "c"],
		]);
	});

	test('unescapes doubled quotes ("")', () => {
		expect(parseCsvRows('"say ""hi""",ok')).toEqual([['say "hi"', "ok"]]);
	});

	test("handles CRLF and lone CR line endings", () => {
		expect(parseCsvRows("a,b\r\n1,2\r\n3,4\r5,6")).toEqual([
			["a", "b"],
			["1", "2"],
			["3", "4"],
			["5", "6"],
		]);
	});

	test("keeps empty fields and skips blank lines, including the trailing newline", () => {
		expect(parseCsvRows("a,b,\n\n1,,3\n")).toEqual([
			["a", "b", ""],
			["1", "", "3"],
		]);
	});

	test("tolerates an unterminated trailing quote instead of dropping the row", () => {
		expect(parseCsvRows('a,b\n1,"cut')).toEqual([
			["a", "b"],
			["1", "cut"],
		]);
	});

	test("treats a mid-field stray quote as literal text", () => {
		expect(parseCsvRows('a"b,c')).toEqual([['a"b', "c"]]);
	});

	test("strips a leading BOM", () => {
		expect(parseCsvRows("\uFEFFa,b\n1,2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});
});

describe("parseCsvTable", () => {
	test("splits header from data rows", () => {
		expect(parseCsvTable("name,age\nann,30\nbo,7")).toEqual({
			header: ["name", "age"],
			rows: [
				["ann", "30"],
				["bo", "7"],
			],
		});
	});

	test("pads short rows and trims long ones to the header width", () => {
		expect(parseCsvTable("a,b,c\n1\n2,3,4,5")).toEqual({
			header: ["a", "b", "c"],
			rows: [
				["1", "", ""],
				["2", "3", "4"],
			],
		});
	});

	test("returns null for empty or whitespace-only content", () => {
		expect(parseCsvTable("")).toBeNull();
		expect(parseCsvTable("  \n ")).toBeNull();
	});

	test("a header-only document grids with zero data rows", () => {
		expect(parseCsvTable("a,b,c")).toEqual({ header: ["a", "b", "c"], rows: [] });
	});
});

describe("compareTableCells", () => {
	test("sorts numerically when both cells are numbers", () => {
		expect(compareTableCells("10", "9")).toBeGreaterThan(0);
		expect(compareTableCells("9", "10")).toBeLessThan(0);
		expect(compareTableCells("2.5", "2.5")).toBe(0);
	});

	test("sorts text locale-aware", () => {
		expect(compareTableCells("banana", "Apple")).toBeGreaterThan(0);
		expect(compareTableCells("a10", "a9")).toBeGreaterThan(0);
	});

	test("empty cells sort last", () => {
		expect(compareTableCells("", "a")).toBeGreaterThan(0);
		expect(compareTableCells("a", "")).toBeLessThan(0);
		expect(compareTableCells("", "")).toBe(0);
	});
});

describe("rowMatchesQuery", () => {
	test("matches any cell case-insensitively, blank query matches all", () => {
		expect(rowMatchesQuery(["Ann", "30"], "ann")).toBe(true);
		expect(rowMatchesQuery(["Ann", "30"], "31")).toBe(false);
		expect(rowMatchesQuery(["Ann", "30"], "")).toBe(true);
		expect(rowMatchesQuery(["Ann", "30"], "  ")).toBe(true);
	});
});

describe("render cap", () => {
	test("the cap is the brief's 5,000 rows", () => {
		expect(MAX_TABLE_RENDER_ROWS).toBe(5000);
	});
});
