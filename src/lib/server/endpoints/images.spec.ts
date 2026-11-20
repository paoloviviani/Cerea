import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { MessageFile } from "$lib/types/Message";
import {
	DEFAULT_IMAGE_PROCESSOR_OPTIONS,
	imageProcessorOptionsFor,
	fitBatchToBudget,
	historyImageOptions,
	imageLimitsSchema,
	makeImageProcessor,
	readImageMetadata,
	ImageTooLargeError,
} from "./images";
import { crc32 } from "node:zlib";

/** A noisy JPEG, so its size does not collapse under compression. */
async function photo(
	width: number,
	height: number,
	opts: { orientation?: number; format?: "jpeg" | "png" } = {}
): Promise<MessageFile> {
	const noise = Buffer.alloc(width * height * 3);
	for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) >>> 24;
	let inst = sharp(noise, { raw: { width, height, channels: 3 } });
	if (opts.orientation) inst = inst.withMetadata({ orientation: opts.orientation });
	const format = opts.format ?? "jpeg";
	const buffer = await (format === "jpeg" ? inst.jpeg({ quality: 95 }) : inst.png()).toBuffer();
	return {
		type: "base64",
		name: `photo.${format}`,
		value: buffer.toString("base64"),
		mime: `image/${format}`,
	};
}

const process = makeImageProcessor(DEFAULT_IMAGE_PROCESSOR_OPTIONS);

async function dims(image: Buffer) {
	const m = await sharp(image).metadata();
	return { width: m.width, height: m.height, orientation: m.orientation };
}

describe("makeImageProcessor", () => {
	it("applies EXIF orientation: a sideways phone photo comes out upright with no tag", async () => {
		// Stored 400x300 with Orientation=6 (rotate 90 clockwise to view): upright it is 300x400.
		const file = await photo(400, 300, { orientation: 6 });
		expect(await dims(Buffer.from(file.value, "base64"))).toMatchObject({
			width: 400,
			height: 300,
			orientation: 6,
		});
		const out = await process(file);
		expect(await dims(out.image)).toEqual({ width: 300, height: 400, orientation: undefined });
	});

	it("puts the pixels the right way up, not just the dimensions", async () => {
		// Left half white, right half black, tagged 6 (clockwise): upright, white is on top.
		const raw = Buffer.alloc(40 * 20 * 3);
		for (let y = 0; y < 20; y += 1) {
			for (let x = 0; x < 40; x += 1)
				raw.fill(x < 20 ? 255 : 0, (y * 40 + x) * 3, (y * 40 + x) * 3 + 3);
		}
		const buffer = await sharp(raw, { raw: { width: 40, height: 20, channels: 3 } })
			.withMetadata({ orientation: 6 })
			.png()
			.toBuffer();
		const out = await process({
			type: "base64",
			name: "p.png",
			value: buffer.toString("base64"),
			mime: "image/png",
		});
		const { data, info } = await sharp(out.image).raw().toBuffer({ resolveWithObject: true });
		expect([info.width, info.height]).toEqual([20, 40]);
		expect(data[(2 * info.width + 10) * info.channels]).toBeGreaterThan(200); // top: white
		expect(data[(37 * info.width + 10) * info.channels]).toBeLessThan(50); // bottom: black
	});

	it("sizes a portrait A4 photo (3024x4032) to 1536x2048", async () => {
		const out = await process(await photo(3024, 4032));
		expect(await dims(out.image)).toMatchObject({ width: 1536, height: 2048 });
		expect(out.mime).toBe("image/jpeg");
	});

	it("measures size after orientation: a landscape-stored portrait photo", async () => {
		const out = await process(await photo(4032, 3024, { orientation: 6 }));
		expect(await dims(out.image)).toMatchObject({ width: 1536, height: 2048 });
	});

	it("leaves a small upright image byte for byte untouched, and never upscales", async () => {
		const file = await photo(600, 400);
		const out = await process(file);
		expect(out.image.equals(Buffer.from(file.value, "base64"))).toBe(true);
	});

	it("keeps the result under the byte cap, lowering quality before size", async () => {
		const file = await photo(1800, 1800);
		const original = Buffer.from(file.value, "base64").byteLength;
		const cap = original / 2 / 1e6; // MB
		const capped = makeImageProcessor({ ...DEFAULT_IMAGE_PROCESSOR_OPTIONS, maxSizeInMB: cap });
		const out = await capped(file);
		expect(out.image.byteLength).toBeLessThanOrEqual(cap * 1e6);
		// Quality alone was enough: the dimensions did not change.
		expect(await dims(out.image)).toMatchObject({ width: 1800, height: 1800 });
	});

	it("takes the dimensions down when quality alone cannot reach the cap", async () => {
		const file = await photo(1800, 1800);
		const capped = makeImageProcessor({ ...DEFAULT_IMAGE_PROCESSOR_OPTIONS, maxSizeInMB: 0.1 });
		const out = await capped(file);
		expect(out.image.byteLength).toBeLessThanOrEqual(100_000);
		expect((await dims(out.image)).width).toBeLessThan(1800);
	});

	it("honours per-model limits", async () => {
		const options = imageProcessorOptionsFor({ imageLimits: { maxWidth: 800, maxHeight: 800 } });
		expect(options).toMatchObject({ maxWidth: 800, maxHeight: 800, maxSizeInMB: 3.75 });
		const out = await makeImageProcessor(options)(await photo(1600, 1200));
		expect(await dims(out.image)).toMatchObject({ width: 800, height: 600 });
	});
});

const budgetFor = (bytes: number) => ({
	bytes,
	historyProcessor: makeImageProcessor(historyImageOptions(DEFAULT_IMAGE_PROCESSOR_OPTIONS)),
});

describe("fitBatchToBudget", () => {
	it("leaves a batch under the budget alone", async () => {
		const files = [await photo(500, 500), await photo(500, 500)];
		const out = await fitBatchToBudget(files, process, budgetFor(50_000_000));
		expect(out.every((r, i) => r.image.equals(Buffer.from(files[i].value, "base64")))).toBe(true);
	});

	it("is deterministic: the same inputs give identical bytes, per image, whatever else is in the batch", async () => {
		const files = await Promise.all([1500, 1500, 1500, 1500].map((n) => photo(n, n)));
		const alone = await process(files[3]);
		const natural = (await Promise.all(files.map((f) => process(f)))).reduce(
			(n, r) => n + r.image.byteLength,
			0
		);
		const first = await fitBatchToBudget(files, process, budgetFor(natural * 2));
		const again = await fitBatchToBudget(files, process, budgetFor(natural * 2));
		first.forEach((r, i) => expect(r.image.equals(again[i].image)).toBe(true));
		// A newer image is added and the budget is tight: the newest keeps exactly its own full-size bytes.
		const withNewer = [...files, await photo(1500, 1500)];
		const tight = await fitBatchToBudget(withNewer, process, budgetFor(Math.floor(natural * 0.6)));
		expect(tight[3].image.equals(alone.image)).toBe(false); // old enough now: shrunk
		expect(tight[4].image.equals((await process(withNewer[4])).image)).toBe(true); // newest: full size
	});

	it("shrinks the OLDEST images to the fixed history size and keeps the newest at full size", async () => {
		const files = await Promise.all([1600, 1600, 1600].map((n) => photo(n, n)));
		const full = await Promise.all(files.map((f) => process(f)));
		const total = full.reduce((n, r) => n + r.image.byteLength, 0);
		const out = await fitBatchToBudget(files, process, budgetFor(total - 1));
		expect(out.reduce((n, r) => n + r.image.byteLength, 0)).toBeLessThanOrEqual(total - 1);
		// Only the oldest needed to shrink, and to the history size (long edge 1024), not by a proportion.
		expect((await dims(out[0].image)).width).toBeLessThanOrEqual(1024);
		expect(out[1].image.equals(full[1].image)).toBe(true);
		expect(out[2].image.equals(full[2].image)).toBe(true);
	});

	it("still holds the budget when even history sizes are over it", async () => {
		const files = await Promise.all([1, 2, 3, 4].map(() => photo(1500, 1500)));
		const out = await fitBatchToBudget(files, process, budgetFor(150_000));
		expect(out.reduce((n, r) => n + r.image.byteLength, 0)).toBeLessThanOrEqual(150_000);
	});
});

/** A PNG that is only a header claiming `side` x `side` pixels: a small file that would decode to gigabytes. */
function pngHeader(side: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body), 8 + data.length);
		return out;
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(side, 0);
	ihdr.writeUInt32BE(side, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", Buffer.from([0x78, 0x9c, 3, 0, 0, 0, 0, 1])),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

describe("decompression bombs", () => {
	it("refuses an image whose header claims more pixels than the limit, with a clear error", async () => {
		const bomb = pngHeader(40_000);
		await expect(readImageMetadata(bomb, "bomb.png")).rejects.toBeInstanceOf(ImageTooLargeError);
		await expect(
			process({
				type: "base64",
				name: "bomb.png",
				value: bomb.toString("base64"),
				mime: "image/png",
			})
		).rejects.toThrow(/too large to read.*bomb\.png|bomb\.png.*too large to read/);
	});
});

describe("imageLimits bounds", () => {
	it("accepts values inside the bounds", () => {
		expect(
			imageLimitsSchema.safeParse({
				maxWidth: 1568,
				maxHeight: 8192,
				maxSizeInMB: 0.25,
				totalBudgetMB: 45,
			}).success
		).toBe(true);
	});

	it.each([
		[{ maxWidth: 100 }, "maxWidth"],
		[{ maxHeight: 9000 }, "maxHeight"],
		[{ maxSizeInMB: 0.1 }, "maxSizeInMB"],
		[{ maxSizeInMB: 50 }, "maxSizeInMB"],
		[{ totalBudgetMB: 0 }, "totalBudgetMB"],
		[{ totalBudgetMB: 60 }, "totalBudgetMB"],
	])("rejects %j with a message naming the field", (value, field) => {
		const result = imageLimitsSchema.safeParse(value);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain(`imageLimits.${field}`);
	});
});
