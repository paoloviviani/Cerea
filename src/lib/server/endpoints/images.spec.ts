import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { MessageFile } from "$lib/types/Message";
import {
	DEFAULT_IMAGE_PROCESSOR_OPTIONS,
	imageProcessorOptionsFor,
	makeImageProcessor,
	processWithBudget,
} from "./images";

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

describe("processWithBudget", () => {
	it("leaves a batch under the budget alone", async () => {
		const files = [await photo(500, 500), await photo(500, 500)];
		const out = await processWithBudget(files, process, 50_000_000);
		expect(out.every((r, i) => r.image.equals(Buffer.from(files[i].value, "base64")))).toBe(true);
	});

	it("shrinks every image in proportion when the batch is over the total budget", async () => {
		const files = await Promise.all([1, 2, 3, 4].map(() => photo(1500, 1500)));
		const natural = (await Promise.all(files.map((f) => process(f)))).reduce(
			(n, r) => n + r.image.byteLength,
			0
		);
		const budget = Math.floor(natural / 3);
		const out = await processWithBudget(files, process, budget);
		const total = out.reduce((n, r) => n + r.image.byteLength, 0);
		expect(total).toBeLessThanOrEqual(budget);
		// All four were reduced, not one sacrificed.
		for (const r of out) expect(r.image.byteLength).toBeLessThan(natural / 4);
	});
});
