import { describe, expect, it } from "vitest";
import { parseFileBlockInfo } from "./fileBlock";

/**
 * Detection for direct-emission file blocks. The contract that matters: the
 * explicit annotation token is the ONLY trigger, so no plain language tag can
 * ever turn a normal code block into a file card.
 */
describe("parseFileBlockInfo", () => {
	it("parses the canonical title= form", () => {
		expect(parseFileBlockInfo("markdown title=report.md")).toEqual({
			language: "markdown",
			filename: "report.md",
		});
		expect(parseFileBlockInfo("csv title=data.csv")).toEqual({
			language: "csv",
			filename: "data.csv",
		});
	});

	it("accepts the file= and filename= aliases", () => {
		expect(parseFileBlockInfo('bash file="data.csv"')).toEqual({
			language: "bash",
			filename: "data.csv",
		});
		expect(parseFileBlockInfo("yaml filename=config.yaml")).toEqual({
			language: "yaml",
			filename: "config.yaml",
		});
	});

	it("tolerates whitespace around the annotation", () => {
		expect(parseFileBlockInfo("markdown  title = report.md")).toEqual({
			language: "markdown",
			filename: "report.md",
		});
		expect(parseFileBlockInfo("  title=notes.txt")).toEqual({
			language: "",
			filename: "notes.txt",
		});
	});

	it("accepts quoted values, including spaces in them", () => {
		expect(parseFileBlockInfo('markdown title="my report.md"')).toEqual({
			language: "markdown",
			filename: "my report.md",
		});
		expect(parseFileBlockInfo("markdown title='report.md'")).toEqual({
			language: "markdown",
			filename: "report.md",
		});
	});

	it("never triggers on a bare language tag or a bare word", () => {
		expect(parseFileBlockInfo("python")).toBeNull();
		expect(parseFileBlockInfo("markdown")).toBeNull();
		expect(parseFileBlockInfo("")).toBeNull();
		expect(parseFileBlockInfo(undefined)).toBeNull();
		// Not a token of its own: the annotation must follow whitespace or start
		// the info string.
		expect(parseFileBlockInfo("notfile=x")).toBeNull();
		expect(parseFileBlockInfo("subtitle=x")).toBeNull();
	});

	it("ignores tokens after the annotation", () => {
		expect(parseFileBlockInfo("markdown title=report.md extra")).toEqual({
			language: "markdown",
			filename: "report.md",
		});
	});

	it("rejects an annotation with an empty value", () => {
		expect(parseFileBlockInfo("markdown title=")).toBeNull();
		expect(parseFileBlockInfo('markdown title=""')).toBeNull();
	});

	it("is case-insensitive on the key", () => {
		expect(parseFileBlockInfo("markdown Title=report.md")).toEqual({
			language: "markdown",
			filename: "report.md",
		});
	});
});
