/**
 * Tool-output images from a coding-agent machine (PROTOCOL.md §6
 * `session.attachment`, §7 tool part `attachments`).
 *
 * The machine's bytes are untrusted — a compromised machine is assumed
 * possible — so nothing it says about an image is believed: the route calls
 * `inspectImage` on the bytes themselves, which decides the type from magic
 * numbers (the claimed mime is ignored), reads the pixel dimensions from the
 * header and refuses a decompression bomb. Nothing here persists an image:
 * Cerea holds no capability at rest, the machine is asked again on every view
 * and the browser caches the answer.
 */
import { base } from "$app/paths";
import type { ToolAttachment } from "$lib/types/machineProtocol";

/** Per-image cap, the same as `files.read`'s image cap. */
export const MAX_TOOL_IMAGE_BYTES = 8 * 1024 * 1024;
/** Refuse anything past ~50 megapixels: a small file can decode to gigabytes. */
export const MAX_TOOL_IMAGE_PIXELS = 50_000_000;
/** Attachments mapped from one tool call; a machine listing more is truncated. */
export const MAX_ATTACHMENTS_PER_CALL = 8;

const SHA256 = /^[0-9a-f]{64}$/;
export const isSha256 = (value: string): boolean => SHA256.test(value);

export type RasterMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface InspectedImage {
	mime: RasterMime;
	width: number;
	height: number;
}

/** The type from the bytes' magic numbers and the size from the header; null
 * for anything that is not one of the four raster types, is truncated, or has
 * a header that cannot be read (fail closed: no dimensions, no image). */
export function inspectImage(bytes: Uint8Array): InspectedImage | null {
	return inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectGif(bytes) ?? inspectWebp(bytes);
}

/** Whether `inspectImage` accepts `bytes` within the pixel budget. */
export function withinPixelBudget(image: InspectedImage): boolean {
	return image.width > 0 && image.height > 0 && image.width * image.height <= MAX_TOOL_IMAGE_PIXELS;
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) =>
	b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const ascii = (b: Uint8Array, o: number, s: string) =>
	b.length >= o + s.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0));

function inspectPng(b: Uint8Array): InspectedImage | null {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (b.length < 24 || !signature.every((v, i) => b[i] === v) || !ascii(b, 12, "IHDR")) return null;
	return { mime: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
}

function inspectJpeg(b: Uint8Array): InspectedImage | null {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
	let o = 2;
	while (o + 4 <= b.length) {
		if (b[o] !== 0xff) return null;
		const marker = b[o + 1];
		if (marker === 0xff) {
			o += 1; // fill byte
			continue;
		}
		// Standalone markers carry no length.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			o += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return null; // ended before any frame header
		const length = u16be(b, o + 2);
		// SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
			if (length < 8 || o + 9 > b.length) return null;
			return { mime: "image/jpeg", height: u16be(b, o + 5), width: u16be(b, o + 7) };
		}
		if (length < 2) return null;
		o += 2 + length;
	}
	return null;
}

function inspectGif(b: Uint8Array): InspectedImage | null {
	if (b.length < 10 || !(ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) return null;
	return { mime: "image/gif", width: u16le(b, 6), height: u16le(b, 8) };
}

function inspectWebp(b: Uint8Array): InspectedImage | null {
	if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
	if (ascii(b, 12, "VP8 ")) {
		// Lossy: frame tag (3 bytes), start code 9d 01 2a, then 14-bit w and h.
		if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
		return { mime: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
	}
	if (ascii(b, 12, "VP8L")) {
		if (b[20] !== 0x2f) return null;
		const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] * 0x1000000);
		return {
			mime: "image/webp",
			width: (bits & 0x3fff) + 1,
			height: ((bits >>> 14) & 0x3fff) + 1,
		};
	}
	if (ascii(b, 12, "VP8X")) {
		return { mime: "image/webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
	}
	return null;
}

/** The URL the panel's `<img>` loads a tool image from: the forwarder's raw
 * attachment route, on the same origin. The sha is validated so a machine
 * cannot smuggle anything else into a URL. */
export function toolImageUrl(deviceId: string, sessionId: string, sha256: string): string {
	return (
		`${base}/api/v2/code/v1/agents/${encodeURIComponent(sessionId)}/attachments/${sha256}` +
		`?device=${encodeURIComponent(deviceId)}`
	);
}

/** Resolver from a sha to its URL, closed over a device and session. */
export type ToolImageUrl = (sha256: string) => string;

const RASTER = new Set<string>(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The attachments a tool part lists, filtered to what may be shown: a
 * well-formed sha, a raster mime and at most `MAX_ATTACHMENTS_PER_CALL`.
 * (The claimed mime only decides whether to try; the route decides the type.) */
export function usableAttachments(list: ToolAttachment[] | undefined): ToolAttachment[] {
	if (!Array.isArray(list)) return [];
	return list
		.filter(
			(a) =>
				a &&
				typeof a.sha256 === "string" &&
				isSha256(a.sha256) &&
				typeof a.mime === "string" &&
				RASTER.has(a.mime) &&
				typeof a.size === "number" &&
				a.size > 0 &&
				a.size <= MAX_TOOL_IMAGE_BYTES
		)
		.slice(0, MAX_ATTACHMENTS_PER_CALL);
}
