import { describe, expect, it } from "vitest";
import {
	MAX_ATTACHMENTS_PER_CALL,
	MAX_TOOL_IMAGE_BYTES,
	MAX_TOOL_IMAGE_PIXELS,
	inspectImage,
	isSha256,
	toolImageUrl,
	usableAttachments,
	withinPixelBudget,
} from "./toolImages";

/** Just enough of each format for its header to be read: the parsers look at
 * magic numbers and the size fields, and nothing past them. */
function pngBytes(width: number, height: number): Uint8Array {
	const b = new Uint8Array(33);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8); // length 13, "IHDR"
	new DataView(b.buffer).setUint32(16, width);
	new DataView(b.buffer).setUint32(20, height);
	return b;
}

function jpegBytes(width: number, height: number, precedingSegments = 0): Uint8Array {
	const parts: number[] = [0xff, 0xd8];
	for (let i = 0; i < precedingSegments; i++) parts.push(0xff, 0xe1, 0, 6, 1, 2, 3, 4); // APPn, length 6
	parts.push(0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff);
	while (parts.length < 40) parts.push(0);
	return Uint8Array.from(parts);
}

function gifBytes(width: number, height: number): Uint8Array {
	return Uint8Array.from([
		...Buffer.from("GIF89a"),
		width & 0xff,
		width >> 8,
		height & 0xff,
		height >> 8,
		0,
		0,
		0,
	]);
}

function webpBytes(kind: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Uint8Array {
	const b = new Uint8Array(40);
	b.set(Buffer.from("RIFF"));
	b.set(Buffer.from("WEBP"), 8);
	b.set(Buffer.from(kind), 12);
	if (kind === "VP8 ") {
		b.set([0x9d, 0x01, 0x2a], 23);
		new DataView(b.buffer).setUint16(26, width, true);
		new DataView(b.buffer).setUint16(28, height, true);
	} else if (kind === "VP8L") {
		b[20] = 0x2f;
		const bits = (width - 1) | ((height - 1) << 14);
		new DataView(b.buffer).setUint32(21, bits >>> 0, true);
	} else {
		const w = width - 1;
		const h = height - 1;
		b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
		b.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
	}
	return b;
}

describe("inspectImage: the type comes from the bytes, never from what the machine claims", () => {
	it("reads PNG, JPEG, GIF and WebP (all three variants) and their sizes", () => {
		expect(inspectImage(pngBytes(640, 480))).toEqual({
			mime: "image/png",
			width: 640,
			height: 480,
		});
		expect(inspectImage(jpegBytes(1024, 768))).toEqual({
			mime: "image/jpeg",
			width: 1024,
			height: 768,
		});
		expect(inspectImage(gifBytes(300, 200))).toEqual({
			mime: "image/gif",
			width: 300,
			height: 200,
		});
		for (const kind of ["VP8 ", "VP8L", "VP8X"] as const) {
			expect(inspectImage(webpBytes(kind, 500, 400))).toEqual({
				mime: "image/webp",
				width: 500,
				height: 400,
			});
		}
	});

	it("finds a JPEG's frame header past other segments", () => {
		expect(inspectImage(jpegBytes(50, 60, 3))).toMatchObject({ width: 50, height: 60 });
	});

	it("refuses SVG, HTML, text and script, whatever they would be labelled", () => {
		const enc = (s: string) => new TextEncoder().encode(s.padEnd(64, " "));
		expect(
			inspectImage(enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))
		).toBeNull();
		expect(inspectImage(enc("<!doctype html><script>alert(1)</script>"))).toBeNull();
		expect(inspectImage(enc("plain text"))).toBeNull();
		expect(inspectImage(new Uint8Array(0))).toBeNull();
	});

	it("refuses a polyglot that only starts like an image", () => {
		// A PNG signature with no IHDR after it is not a PNG.
		const b = pngBytes(1, 1);
		b.set(Buffer.from("XXXX"), 12);
		expect(inspectImage(b)).toBeNull();
		// JPEG magic that ends before any frame header.
		expect(inspectImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0]))).toBeNull();
	});

	it("refuses truncated headers rather than guessing a size", () => {
		expect(inspectImage(pngBytes(10, 10).slice(0, 20))).toBeNull();
		expect(inspectImage(gifBytes(1, 1).slice(0, 8))).toBeNull();
		expect(inspectImage(webpBytes("VP8X", 9, 9).slice(0, 20))).toBeNull();
	});
});

describe("the pixel budget (decompression-bomb guard)", () => {
	it("accepts up to the limit and refuses past it, for every format that carries a size", () => {
		const side = Math.floor(Math.sqrt(MAX_TOOL_IMAGE_PIXELS));
		expect(withinPixelBudget(inspectImage(pngBytes(side, side)) as never)).toBe(true);
		expect(withinPixelBudget(inspectImage(pngBytes(side + 100, side + 100)) as never)).toBe(false);
		// 4 gigapixels in a few dozen bytes:
		expect(withinPixelBudget(inspectImage(pngBytes(65535, 65535)) as never)).toBe(false);
		expect(withinPixelBudget(inspectImage(jpegBytes(65535, 65535)) as never)).toBe(false);
		expect(withinPixelBudget(inspectImage(webpBytes("VP8X", 16384, 16384)) as never)).toBe(false);
	});

	it("refuses a zero-sized image", () => {
		expect(withinPixelBudget(inspectImage(pngBytes(0, 100)) as never)).toBe(false);
	});
});

describe("usableAttachments", () => {
	const sha = "a".repeat(64);
	const good = { sha256: sha, mime: "image/png", size: 10 };

	it("keeps a well-formed raster attachment", () => {
		expect(usableAttachments([good])).toEqual([good]);
	});

	it("drops a malformed sha, a non-raster mime and an unusable size", () => {
		expect(
			usableAttachments([
				{ ...good, sha256: "../../etc/passwd" },
				{ ...good, sha256: "A".repeat(64) },
				{ ...good, mime: "image/svg+xml" },
				{ ...good, mime: "text/html" },
				{ ...good, size: 0 },
				{ ...good, size: MAX_TOOL_IMAGE_BYTES + 1 },
			])
		).toEqual([]);
	});

	it("caps a call's images", () => {
		const many = Array.from({ length: MAX_ATTACHMENTS_PER_CALL + 5 }, (_, i) => ({
			...good,
			sha256: i.toString(16).padStart(64, "0"),
		}));
		expect(usableAttachments(many)).toHaveLength(MAX_ATTACHMENTS_PER_CALL);
	});

	it("tolerates a machine that omits or mangles the field", () => {
		expect(usableAttachments(undefined)).toEqual([]);
		expect(usableAttachments("nope" as never)).toEqual([]);
	});
});

describe("toolImageUrl", () => {
	it("is a same-origin path naming the device and session", () => {
		const url = toolImageUrl("dev1", "ses_1", "b".repeat(64));
		expect(url).toBe(`/api/v2/code/v1/agents/ses_1/attachments/${"b".repeat(64)}?device=dev1`);
		expect(url.startsWith("/") && !url.startsWith("//")).toBe(true);
	});

	it("isSha256 is lowercase hex, exactly 64", () => {
		expect(isSha256("0".repeat(64))).toBe(true);
		expect(isSha256("0".repeat(63))).toBe(false);
		expect(isSha256("G".repeat(64))).toBe(false);
	});
});
