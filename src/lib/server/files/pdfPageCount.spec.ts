import { describe, expect, it, vi } from "vitest";
import { pdfPageCount } from "./pdfPageCount";

const TWO_PAGES = Buffer.from(
	"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n" +
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\n4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\n" +
		"trailer<</Root 1 0 R/Size 5>>\n%%EOF"
);

describe("pdfPageCount", () => {
	it("counts the pages of a PDF", async () => {
		expect(await pdfPageCount(new Uint8Array(TWO_PAGES))).toBe(2);
	});
	it("answers unknown for bytes that are not a PDF, and when it takes longer than the timeout", async () => {
		expect(await pdfPageCount(new Uint8Array(Buffer.from("not a pdf")))).toBeNull();
	});
	it("gives up on a PDF that never finishes opening", async () => {
		vi.resetModules();
		vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
			getDocument: () => ({
				promise: new Promise(() => undefined),
				destroy: async () => undefined,
			}),
		}));
		const { pdfPageCount: hung } = await import("./pdfPageCount");
		expect(await hung(new Uint8Array(TWO_PAGES), 20)).toBeNull();
		vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
	});
});
