/**
 * Small pictures of stored images, for the tiles of a message: `?thumb=<px>` on a conversation's file
 * route. A phone photo is 3-4 MB and a tile shows 110 px of it, so the tile asks for this instead of the
 * original (which the lightbox and the download still use).
 *
 * The route has already checked the conversation and `statFile` the file (a withheld file never gets
 * here), so what is cached is only ever derived from bytes the caller may read. The cache is keyed by
 * the content hash and the size: the same bytes give the same thumbnail whoever asks, and it is
 * bounded by bytes (`THUMB_CACHE_BYTES`), least recently used out first, so it never grows without limit.
 */
import { error } from "@sveltejs/kit";
import sharp from "sharp";
import { IMAGE_PIXEL_LIMIT } from "$lib/server/endpoints/images";
import { isThumbnailable } from "$lib/utils/thumbnailable";

/** The long edges a thumbnail may have; anything else is a 400, so the cache keys stay few. */
export const THUMB_SIZES = [160, 320, 640] as const;
/** Formats that are decoded as pictures; anything else (SVG, PDF, text) has no thumbnail. */
export const THUMB_CACHE_BYTES = 32 * 1024 * 1024;
/** Content-addressed: the URL names the bytes, so a browser may keep the answer for a year. */
export const THUMB_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** The size the request asks for: null for a plain request, a 400 for a size that is not offered. */
export function parseThumbSize(url: URL): number | null {
	const raw = url.searchParams.get("thumb");
	if (raw === null) return null;
	const size = Number(raw);
	if (!(THUMB_SIZES as readonly number[]).includes(size)) {
		error(400, `thumb must be one of ${THUMB_SIZES.join(", ")}.`);
	}
	return size;
}

class ThumbCache {
	private entries = new Map<string, Buffer>();
	private bytes = 0;
	constructor(private readonly limit: number) {}
	get(key: string): Buffer | undefined {
		const hit = this.entries.get(key);
		if (hit) {
			this.entries.delete(key);
			this.entries.set(key, hit);
		}
		return hit;
	}
	set(key: string, value: Buffer): void {
		if (value.length > this.limit) return;
		const old = this.entries.get(key);
		if (old) this.bytes -= old.length;
		this.entries.delete(key);
		this.entries.set(key, value);
		this.bytes += value.length;
		for (const [oldest, buf] of this.entries) {
			if (this.bytes <= this.limit) break;
			this.entries.delete(oldest);
			this.bytes -= buf.length;
		}
	}
	get size() {
		return this.bytes;
	}
	clear() {
		this.entries.clear();
		this.bytes = 0;
	}
}

const cache = new ThumbCache(THUMB_CACHE_BYTES);
/** Concurrent requests for one thumbnail (a message opened with the same image twice) share one render. */
const inflight = new Map<string, Promise<Buffer>>();

/** Test hook: empties the cache and reports what it holds. */
export const thumbCache = { clear: () => cache.clear(), bytes: () => cache.size };

export function thumbEtag(sha256: string, size: number): string {
	return `"${sha256}-t${size}"`;
}

/** A JPEG decodes at a fraction of its size (shrink-on-load); anything else decodes whole, so it gets a lower cap. */
export const THUMB_PIXEL_LIMIT = 40_000_000;
/** How many pictures are decoded at once: a 40 MP PNG is about 160 MB of pixels. */
export const THUMB_RENDERS = 2;

/** At most `limit` of the tasks run at once; the rest wait their turn, in order. */
export function createSemaphore(limit: number) {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async function run<T>(task: () => Promise<T>): Promise<T> {
		if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
		active += 1;
		try {
			return await task();
		} finally {
			active -= 1;
			waiting.shift()?.();
		}
	};
}
const limited = createSemaphore(THUMB_RENDERS);

function render(bytes: Buffer, size: number, mime: string): Promise<Buffer> {
	return limited(() => renderNow(bytes, size, mime));
}

async function renderNow(bytes: Buffer, size: number, mime: string): Promise<Buffer> {
	try {
		const limit = mime === "image/jpeg" ? IMAGE_PIXEL_LIMIT : THUMB_PIXEL_LIMIT;
		return await sharp(bytes, { limitInputPixels: limit })
			// Upright by the EXIF orientation, which the re-encode then drops.
			.rotate()
			.resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
			.webp({ quality: 72 })
			.toBuffer();
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/pixel limit/i.test(message)) {
			error(413, "This image is too large to preview.");
		}
		error(422, "This image cannot be previewed.");
	}
}

/**
 * The thumbnail response for one file the caller may read. `read` is only called when the picture has to be
 * made; an `If-None-Match` that names it is answered 304 without reading anything.
 */
export async function thumbnailResponse(options: {
	sha256: string;
	size: number;
	mime: string | undefined;
	request: Request;
	read: () => Promise<Buffer>;
}): Promise<Response> {
	const { sha256, size, request } = options;
	const mime = options.mime?.split(";")[0]?.trim().toLowerCase();
	if (!mime || !isThumbnailable(mime)) error(415, "This file has no thumbnail.");

	const etag = thumbEtag(sha256, size);
	const headers: Record<string, string> = {
		ETag: etag,
		"Cache-Control": THUMB_CACHE_CONTROL,
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'none'; sandbox;",
	};
	const match = request.headers.get("if-none-match");
	if (match && match.split(",").some((tag) => tag.trim() === etag || tag.trim() === `W/${etag}`)) {
		return new Response(null, { status: 304, headers });
	}

	const key = `${sha256}:${size}`;
	let body = cache.get(key);
	if (!body) {
		let pending = inflight.get(key);
		if (!pending) {
			pending = options.read().then((bytes) => render(bytes, size, mime));
			inflight.set(key, pending);
			pending.then(
				(made) => {
					inflight.delete(key);
					cache.set(key, made);
				},
				() => inflight.delete(key)
			);
		}
		body = await pending;
	}
	return new Response(new Uint8Array(body), {
		headers: {
			...headers,
			"Content-Type": "image/webp",
			"Content-Length": String(body.length),
			"Content-Disposition": `attachment; filename="${sha256.slice(0, 8)}-${size}.webp"`,
		},
	});
}
