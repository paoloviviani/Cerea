import { describe, it, expect } from "vitest";
import { buildPdf, jpegSize } from "./pdf";

// A 1x1 JPEG
const JPEG = Uint8Array.from(
	atob(
		"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
	),
	(c) => c.charCodeAt(0)
);

describe("jpegSize", () => {
	it("reads the frame size and refuses other bytes", () => {
		expect(jpegSize(JPEG)).toEqual({ width: 1, height: 1 });
		expect(jpegSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
	});
});

describe("buildPdf", () => {
	it("writes a PDF with one page per slide and a valid cross-reference table", async () => {
		const blob = buildPdf(
			[
				{ jpeg: JPEG, width: 1280, height: 720 },
				{ jpeg: JPEG, width: 1280, height: 720 },
			],
			"Deck (1)"
		);
		expect(blob.type).toBe("application/pdf");
		const text = new TextDecoder("latin1").decode(await blob.arrayBuffer());
		expect(text.startsWith("%PDF-1.4")).toBe(true);
		expect(text).toContain("/Count 2");
		expect(text).toContain("/MediaBox [0 0 960 540]");
		expect(text).toContain("/Title (Deck 1)");
		const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
		expect(text.slice(startxref, startxref + 4)).toBe("xref");
		// Every xref entry points at "N 0 obj"
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const latin = new TextDecoder("latin1").decode(bytes);
		const entries = [...latin.slice(startxref).matchAll(/(\d{10}) 00000 n/g)];
		expect(entries.length).toBe(3 + 2 * 3);
		entries.forEach((m, i) => {
			expect(latin.slice(Number(m[1])).startsWith(`${i + 1} 0 obj`)).toBe(true);
		});
	});
});
