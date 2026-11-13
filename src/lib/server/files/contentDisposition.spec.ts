import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "./contentDisposition";

describe("attachmentDisposition", () => {
	it("keeps a plain name as it is, and still gives the encoded form", () => {
		expect(attachmentDisposition("report.xlsx")).toBe(
			`attachment; filename="report.xlsx"; filename*=UTF-8''report.xlsx`
		);
	});

	it("can be set as a header for a name outside Latin-1", () => {
		const value = attachmentDisposition("分析 – résumé (1).csv");
		// Headers throws on a value with a character above U+00FF: this is the bug it prevents.
		expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
		expect(value).toContain(
			`filename*=UTF-8''%E5%88%86%E6%9E%90%20%E2%80%93%20r%C3%A9sum%C3%A9%20%281%29.csv`
		);
		expect(value.split(";")[1]).toMatch(/^ filename="[\x20-\x7e]*"$/);
	});

	it("cannot be made to inject a header or break out of the quotes", () => {
		const value = attachmentDisposition('a"\r\nSet-Cookie: x=1;b\\c.txt');
		expect(value).not.toMatch(/[\r\n]/);
		expect(value.split(";")[1]).not.toContain('"b');
		expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
	});

	it("falls back when nothing printable is left", () => {
		expect(attachmentDisposition("日本語")).toContain('filename="___"');
		expect(attachmentDisposition("")).toContain('filename="download"');
	});
});
