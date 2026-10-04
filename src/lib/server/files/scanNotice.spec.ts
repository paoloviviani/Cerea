import { describe, expect, it } from "vitest";
import { scanNotice, wordScanMarkers } from "./scanNotice";

const scan = (pages: number[], over = {}) => ({
	files: pages.map((page) => ({ page, value: `h${page}`, mime: "image/jpeg" })),
	pageCount: 10,
	scannedTotal: pages.length,
	truncated: false,
	...over,
});

describe("scanNotice", () => {
	it("lists pages as runs", () => {
		expect(scanNotice("a.pdf", scan([1, 2, 3, 5, 7, 8]), true)).toContain(
			"pages 1–3, 5, 7–8 are scans"
		);
	});

	it("says a lone page in the singular", () => {
		expect(scanNotice("a.pdf", scan([4]), true)).toContain(
			"page 4 is a scan, attached as an image"
		);
		expect(scanNotice("a.pdf", scan([4]), false)).toContain(
			"page 4 is a scan and the current model cannot read images"
		);
	});

	it("names a PDF with no text of its own as a scanned one", () => {
		expect(scanNotice("a.pdf", scan([1, 2], { pageCount: 2 }), true)).toBe(
			"Scanned PDF a.pdf: pages 1–2 attached as images."
		);
	});

	it("says only the first K image pages of M when truncated", () => {
		expect(
			scanNotice("a.pdf", scan([1, 2], { scannedTotal: 31, truncated: true }), true)
		).toContain("Only the first 2 image pages of 31 were attached");
	});

	it("never claims images were attached to a model that was not sent them", () => {
		expect(scanNotice("a.pdf", scan([1, 2]), false)).not.toMatch(/attached as/);
	});
});

describe("wordScanMarkers", () => {
	const text = "one\n\n[[cerea:scan-page:2]]\n\nthree";
	it("words each marker for the turn's model", () => {
		expect(wordScanMarkers(text, true)).toContain("Page 2 is a scan, attached as an image.");
		expect(wordScanMarkers(text, false)).toContain("Page 2 is a scan; its image was not sent");
	});
	it("can be run twice: the marker regex is global", () => {
		expect(wordScanMarkers(text, true)).toBe(wordScanMarkers(text, true));
	});
});
