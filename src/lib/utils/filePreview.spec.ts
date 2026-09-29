import { describe, expect, test } from "vitest";
import {
	FILE_PREVIEW_MAX_BYTES,
	FILE_PREVIEW_TEXT_CHARS,
	FILE_PREVIEW_TEXT_MAX_BYTES,
	fileExtensionOf,
	filePreviewKindFor,
	filePreviewMimeType,
	formatFileSize,
	isInlineRasterImage,
	isInlineRasterMime,
} from "./filePreview";

describe("filePreviewKindFor", () => {
	test("routes text, image, pdf and docx by extension", () => {
		expect(filePreviewKindFor("notes.txt")).toBe("text");
		expect(filePreviewKindFor("data.CSV")).toBe("text");
		expect(filePreviewKindFor("report.md")).toBe("text");
		expect(filePreviewKindFor("photo.png")).toBe("image");
		expect(filePreviewKindFor("fig.svg")).toBe("image");
		expect(filePreviewKindFor("paper.pdf")).toBe("pdf");
		expect(filePreviewKindFor("paper.docx")).toBe("docx");
	});

	test("docx needs real bytes; inline content is never a docx", () => {
		expect(filePreviewKindFor("paper.docx", { fromBytes: false })).toBe("none");
		expect(filePreviewKindFor("notes.txt", { fromBytes: false })).toBe("text");
	});

	test("unknown and extensionless names get the download card", () => {
		expect(filePreviewKindFor("archive.zip")).toBe("none");
		expect(filePreviewKindFor("README")).toBe("none");
	});
});

describe("fileExtensionOf", () => {
	test("takes the last segment and lowercases it", () => {
		expect(fileExtensionOf("out/report.PDF")).toBe("pdf");
		expect(fileExtensionOf("noext")).toBe("");
		expect(fileExtensionOf("a.b.c")).toBe("c");
	});
});

describe("filePreviewMimeType", () => {
	test("types pdf for the native viewer and images explicitly", () => {
		expect(filePreviewMimeType("pdf")).toBe("application/pdf");
		expect(filePreviewMimeType("png")).toBe("image/png");
		expect(filePreviewMimeType("svg")).toBe("image/svg+xml");
		expect(filePreviewMimeType("zip")).toBe("application/octet-stream");
	});
});

describe("caps and formatting", () => {
	test("the document cap is the FileCard 8 MB and text stays capped", () => {
		expect(FILE_PREVIEW_MAX_BYTES).toBe(8 * 1024 * 1024);
		expect(FILE_PREVIEW_TEXT_MAX_BYTES).toBe(2 * 1024 * 1024);
		expect(FILE_PREVIEW_TEXT_CHARS).toBe(4000);
	});

	test("formats sizes like the card always did", () => {
		expect(formatFileSize(512)).toBe("512 B");
		expect(formatFileSize(2048)).toBe("2.0 KB");
		expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
	});
});

describe("the inline raster rule", () => {
	test("admits png, jpeg, gif and webp by name, in any case", () => {
		for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.WebP", "dir/figure-1.png"]) {
			expect(isInlineRasterImage(name), name).toBe(true);
		}
	});

	test("never admits SVG, or a type a browser may not decode", () => {
		for (const name of ["a.svg", "b.SVG", "c.bmp", "d.avif", "e.pdf", "png", "f.png.svg"]) {
			expect(isInlineRasterImage(name), name).toBe(false);
		}
	});

	test("applies the same rule to a reported MIME type", () => {
		for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/PNG"]) {
			expect(isInlineRasterMime(mime), mime).toBe(true);
		}
		for (const mime of ["image/svg+xml", "text/html", "application/octet-stream", "", undefined]) {
			expect(isInlineRasterMime(mime), String(mime)).toBe(false);
		}
	});
});
