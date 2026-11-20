import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { putBlob, removeBlobs } from "$lib/server/blobs/testing";
import { IMAGE_PIXEL_LIMIT } from "$lib/server/endpoints/images";
import { thumbCache, THUMB_CACHE_BYTES } from "$lib/server/files/thumbnail";
import { GET } from "./+server";

beforeAll(async () => {
	await ready;
});

async function flat(width: number, height: number, background: string): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background } })
		.jpeg()
		.toBuffer();
}

/** A noisy 3000x4000 JPEG whose EXIF orientation 6 says "rotate to the right": upright it is 4000x3000. */
async function photo(): Promise<Buffer> {
	const raw = Buffer.alloc(3000 * 4000 * 3);
	for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 31 + (i >> 9)) & 255;
	return sharp(raw, { raw: { width: 3000, height: 4000, channels: 3 } })
		.withMetadata({ orientation: 6 })
		.jpeg({ quality: 90 })
		.toBuffer();
}

async function store(
	conv: { _id: { toString(): string } },
	bytes: Buffer,
	extra: Record<string, unknown> = {},
	mime = "image/jpeg"
) {
	const sha = createHash("sha256").update(bytes).digest("hex");
	await putBlob(
		`${conv._id.toString()}-${sha}`,
		{ conversation: conv._id.toString(), mime, ...extra },
		bytes
	);
	return sha;
}

function get(
	locals: App.Locals,
	convId: string,
	sha: string,
	query = "",
	headers: Record<string, string> = {}
) {
	return GET({
		locals,
		params: { id: convId, sha256: sha },
		url: new URL(`http://localhost/conversation/${convId}/output/${sha}${query}`),
		request: new Request("http://localhost/x", { headers }),
	} as never);
}

describe.sequential("GET /conversation/[id]/output/[sha256]?thumb=", () => {
	beforeEach(() => thumbCache.clear());
	afterEach(async () => {
		await removeBlobs({});
		await cleanupTestData();
	});

	it("serves a small upright WebP, far smaller than the original, with immutable cache headers and an ETag", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		const original = await photo();
		const sha = await store(conv, original);

		const res = await get(locals, conv._id.toString(), sha, "?thumb=320");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/webp");
		expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		expect(res.headers.get("etag")).toBe(`"${sha}-t320"`);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");

		const bytes = Buffer.from(await res.arrayBuffer());
		expect(bytes.length).toBeLessThan(original.length / 10);
		const meta = await sharp(bytes).metadata();
		expect(meta.format).toBe("webp");
		// EXIF-upright: the stored 3000x4000 with orientation 6 is a landscape picture, long edge 320.
		expect(meta.width).toBe(320);
		expect(meta.height).toBe(240);
	});

	it("answers a matching If-None-Match with 304 and no body", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		const sha = await store(conv, await flat(800, 600, "#c33"));

		const first = await get(locals, conv._id.toString(), sha, "?thumb=160");
		const etag = first.headers.get("etag") ?? "";
		const again = await get(locals, conv._id.toString(), sha, "?thumb=160", {
			"If-None-Match": etag,
		});
		expect(again.status).toBe(304);
		expect(again.headers.get("etag")).toBe(etag);
		expect(await again.text()).toBe("");
	});

	it("still checks access before a 304: another user's cached ETag gets nothing", async () => {
		const { locals } = await createTestUser();
		const { locals: stranger } = await createTestUser();
		const conv = await createTestConversation(locals);
		const sha = await store(conv, await flat(400, 300, "#33c"));

		await expect(
			get(stranger, conv._id.toString(), sha, "?thumb=160", { "If-None-Match": `"${sha}-t160"` })
		).rejects.toMatchObject({ status: 404 });
	});

	it("refuses a file a privacy rule withheld, exactly as the original is", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		const sha = await store(conv, await flat(400, 300, "#3c3"), { withheldRule: "no-faces" });

		await expect(get(locals, conv._id.toString(), sha)).rejects.toMatchObject({ status: 403 });
		await expect(get(locals, conv._id.toString(), sha, "?thumb=320")).rejects.toMatchObject({
			status: 403,
		});
		// Not even a 304 for a client that already holds it.
		await expect(
			get(locals, conv._id.toString(), sha, "?thumb=320", { "If-None-Match": `"${sha}-t320"` })
		).rejects.toMatchObject({ status: 403 });
	});

	it("does not serve a withheld copy from the cache of the same bytes elsewhere", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		const bytes = await flat(400, 300, "#cc3");
		const sha = await store(conv, bytes);
		expect((await get(locals, conv._id.toString(), sha, "?thumb=320")).status).toBe(200);

		const other = await createTestConversation(locals);
		expect(await store(other, bytes, { withheldRule: "r" })).toBe(sha);
		await expect(get(locals, other._id.toString(), sha, "?thumb=320")).rejects.toMatchObject({
			status: 403,
		});
	});

	it("keeps the conversation check: another user's conversation is a 404, thumbnail or not", async () => {
		const { locals } = await createTestUser();
		const { locals: stranger } = await createTestUser();
		const conv = await createTestConversation(locals);
		const sha = await store(conv, await flat(400, 300, "#999"));

		await expect(get(stranger, conv._id.toString(), sha, "?thumb=320")).rejects.toMatchObject({
			status: 404,
		});
		await expect(get(stranger, conv._id.toString(), sha)).rejects.toMatchObject({ status: 404 });
	});

	it("serves the original, byte for byte, without ?thumb", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		const original = await flat(400, 300, "#777");
		const sha = await store(conv, original);

		const res = await get(locals, conv._id.toString(), sha);
		expect(res.headers.get("content-type")).toBe("image/jpeg");
		expect(Buffer.from(await res.arrayBuffer()).equals(original)).toBe(true);
	});

	it("rejects a size that is not offered, and a file that is not a picture", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		const sha = await store(conv, Buffer.from("hello"), {}, "text/plain");
		await expect(get(locals, conv._id.toString(), sha, "?thumb=99999")).rejects.toMatchObject({
			status: 400,
		});
		await expect(get(locals, conv._id.toString(), sha, "?thumb=320")).rejects.toMatchObject({
			status: 415,
		});
	});

	it("refuses an image past the pixel limit without decoding it", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		// A valid PNG of 10001 x 10000 px (100.01 MP, past the limit): one flat colour, so a few KB.
		const huge = await sharp({
			create: { width: 10_001, height: 10_000, channels: 3, background: "#000" },
			limitInputPixels: false,
		})
			.png({ compressionLevel: 9 })
			.toBuffer();
		expect(10_001 * 10_000).toBeGreaterThan(IMAGE_PIXEL_LIMIT);
		const sha = await store(conv, huge, {}, "image/png");
		await expect(get(locals, conv._id.toString(), sha, "?thumb=320")).rejects.toMatchObject({
			status: 413,
		});
	}, 60_000);

	it("refuses a PNG past the lower pixel cap that non-JPEG pictures get, and says SVG has no thumbnail", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		const big = await sharp({
			create: { width: 7000, height: 6000, channels: 3, background: "#000" },
		})
			.png({ compressionLevel: 9 })
			.toBuffer();
		const sha = await store(conv, big, {}, "image/png");
		await expect(get(locals, conv._id.toString(), sha, "?thumb=320")).rejects.toMatchObject({
			status: 413,
		});
		const svg = await store(
			conv,
			Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
			{},
			"image/svg+xml"
		);
		await expect(get(locals, conv._id.toString(), svg, "?thumb=320")).rejects.toMatchObject({
			status: 415,
		});
	}, 60_000);

	it("keeps its cache within the byte bound", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		const sha = await store(conv, await flat(500, 500, "#123"));
		await get(locals, conv._id.toString(), sha, "?thumb=640");
		expect(thumbCache.bytes()).toBeGreaterThan(0);
		expect(thumbCache.bytes()).toBeLessThanOrEqual(THUMB_CACHE_BYTES);
	});
});
