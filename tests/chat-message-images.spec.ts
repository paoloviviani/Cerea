/**
 * The pictures attached to a message load as one: small versions (`?thumb=`) of the stored images, in
 * fixed-size tiles that shimmer while they load and fade in together, never one after another.
 *
 * The owner opened a conversation with seven phone photos and saw the tiles pop in one by one after a
 * couple of seconds: each tile downloaded its multi-megabyte original. The images are stored straight
 * into the blob store (the composer would send 25 MB through the browser), and a recorder in the page
 * samples every frame, so "never partly visible" is observed, not inferred.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { Page } from "playwright/test";
import { createHash } from "node:crypto";
import { GridFSBucket, type Db, type ObjectId } from "mongodb";
import sharp from "sharp";

const COUNT = 7;
const TILE_W = 112;
const TILE_H = 144;

async function photo(seed: number): Promise<Buffer> {
	const w = 1800;
	const h = 2400;
	const raw = Buffer.alloc(w * h * 3);
	let s = seed * 7919 + 1;
	for (let i = 0; i < raw.length; i += 1) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		raw[i] = (((i / 3) | 0) % w) / 8 + ((s >> 16) % 30);
	}
	return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
		.jpeg({ quality: 88 })
		.toBuffer();
}

async function seedPhotos(
	db: Db,
	seedConversation: (input: Record<string, unknown>) => Promise<ObjectId>
): Promise<{ id: ObjectId; sizes: number[]; shas: string[] }> {
	const photos = await Promise.all(Array.from({ length: COUNT }, (_, i) => photo(i)));
	const entries = photos.map((buffer, i) => ({
		buffer,
		name: `invoice-${i + 1}.jpg`,
		sha: createHash("sha256").update(buffer).digest("hex"),
	}));
	const id = await seedConversation({
		messages: [
			{ from: "system", content: "" },
			{
				from: "user",
				content: "my invoices",
				extra: {
					files: entries.map((e) => ({
						type: "hash",
						name: e.name,
						mime: "image/jpeg",
						value: e.sha,
					})),
				},
			},
			{ from: "assistant", content: "Got them." },
		],
	});
	const bucket = new GridFSBucket(db, { bucketName: "files" });
	for (const e of entries) {
		await new Promise<void>((resolve, reject) => {
			const stream = bucket.openUploadStream(`${id.toString()}-${e.sha}`, {
				metadata: { conversation: id.toString(), mime: "image/jpeg" },
			});
			stream.once("finish", () => resolve());
			stream.once("error", reject);
			stream.end(e.buffer);
		});
	}
	return { id, sizes: photos.map((p) => p.length), shas: entries.map((e) => e.sha) };
}

/** Samples every frame: how many tiles show a picture, the tile boxes, and whether a placeholder was drawn. */
async function installRecorder(page: Page) {
	await page.addInitScript(() => {
		const rec = {
			visible: new Set<number>(),
			widths: new Set<number>(),
			heights: new Set<number>(),
			rowHeights: new Set<number>(),
			shimmer: false,
			done: false,
		};
		(window as unknown as { __rec: typeof rec }).__rec = rec;
		const frame = () => {
			const imgs = [...document.querySelectorAll<HTMLImageElement>('img[alt^="invoice-"]')];
			if (imgs.length > 0) {
				const shown = imgs.filter(
					(im) => im.complete && im.naturalWidth > 0 && getComputedStyle(im).opacity !== "0"
				).length;
				rec.visible.add(shown);
				for (const im of imgs) {
					const box = (im.parentElement ?? im).getBoundingClientRect();
					rec.widths.add(Math.round(box.width));
					rec.heights.add(Math.round(box.height));
				}
				const row = imgs[0]?.closest('[data-message-type="user"]');
				if (row) rec.rowHeights.add(Math.round(row.getBoundingClientRect().height));
				if (document.querySelector('[data-testid="skeleton"]')) rec.shimmer = true;
				if (shown === imgs.length && imgs.length > 0) rec.done = true;
			}
			requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
	});
}

interface Recorded {
	visible: number[];
	widths: number[];
	heights: number[];
	rowHeights: number[];
	shimmer: boolean;
	done: boolean;
}
const recorded = (page: Page) =>
	page.evaluate((): Recorded => {
		const r = (window as unknown as { __rec: Record<string, unknown> }).__rec as {
			visible: Set<number>;
			widths: Set<number>;
			heights: Set<number>;
			rowHeights: Set<number>;
			shimmer: boolean;
			done: boolean;
		};
		return {
			visible: [...r.visible].sort(),
			widths: [...r.widths],
			heights: [...r.heights],
			rowHeights: [...r.rowHeights],
			shimmer: r.shimmer,
			done: r.done,
		};
	});

test("tiles ask for thumbnails, not the originals", async ({ page, db, seedConversation }) => {
	test.setTimeout(120_000);
	const { id, sizes } = await seedPhotos(db, seedConversation);
	const responses: Array<{ url: string; length: number; cacheControl: string }> = [];
	page.on("response", (res) => {
		if (res.url().includes(`/conversation/${id.toString()}/output/`)) {
			responses.push({
				url: res.url(),
				length: Number(res.headers()["content-length"] ?? 0),
				cacheControl: res.headers()["cache-control"] ?? "",
			});
		}
	});
	await page.goto(`${E2E_APP_BASE}/conversation/${id.toString()}`);
	await expect(page.locator('[data-testid="message-image-tile"] img')).toHaveCount(COUNT);
	await expect(page.locator('[data-testid="message-image-tile"][data-shown="true"]')).toHaveCount(
		COUNT
	);

	expect(responses).toHaveLength(COUNT);
	for (const r of responses) {
		expect(r.url).toContain("?thumb=320");
		expect(r.length).toBeGreaterThan(0);
		expect(r.cacheControl).toBe("private, max-age=31536000, immutable");
		expect(r.length).toBeLessThan(Math.min(...sizes) / 10);
	}
});

test("the tiles of a message appear together, in boxes that never change size", async ({
	page,
	db,
	seedConversation,
}) => {
	test.setTimeout(120_000);
	const { id } = await seedPhotos(db, seedConversation);
	await installRecorder(page);
	// Each picture arrives at a different time.
	const delays = [100, 1300, 400, 1000, 200, 800, 600];
	let n = 0;
	await page.route("**/output/*", async (route) => {
		const delay = delays[n++ % delays.length] ?? 0;
		await new Promise((resolve) => setTimeout(resolve, delay));
		await route.continue().catch(() => undefined);
	});
	await page.goto(`${E2E_APP_BASE}/conversation/${id.toString()}`);
	await page.waitForFunction(
		() => (window as unknown as { __rec: { done: boolean } }).__rec.done,
		null,
		{ timeout: 20_000 }
	);
	await page.waitForTimeout(300);

	const rec = await recorded(page);
	// Never some of them: none, then all.
	expect(rec.visible).toEqual([0, COUNT]);
	// A placeholder was drawn while they loaded (the wait was past the 150 ms grace).
	expect(rec.shimmer).toBe(true);
	// The box is the same size from the first frame to the last, and so is the message.
	expect(rec.widths).toEqual([TILE_W]);
	expect(rec.heights).toEqual([TILE_H]);
	expect(rec.rowHeights).toHaveLength(1);
});

test("a picture that is slower than the cap does not hold the others back", async ({
	page,
	db,
	seedConversation,
}) => {
	test.setTimeout(120_000);
	const { id, shas } = await seedPhotos(db, seedConversation);
	await installRecorder(page);
	await page.route("**/output/*", async (route) => {
		const slow = route
			.request()
			.url()
			.includes(shas[0] ?? "-");
		await new Promise((resolve) => setTimeout(resolve, slow ? 6000 : 50));
		await route.continue().catch(() => undefined);
	});
	// Not waiting for `load`: it would wait for the slow picture too.
	await page.goto(`${E2E_APP_BASE}/conversation/${id.toString()}`, { waitUntil: "commit" });
	// After about two seconds the six that loaded show, while the seventh still has its placeholder.
	await expect(page.locator('[data-testid="message-image-tile"][data-shown="true"]')).toHaveCount(
		COUNT - 1,
		{ timeout: 4500 }
	);
	await expect(page.getByTestId("skeleton")).toHaveCount(1);
	await expect(page.locator('[data-testid="message-image-tile"][data-shown="true"]')).toHaveCount(
		COUNT,
		{ timeout: 15_000 }
	);
});

test("thumbnails that are ready at once show no placeholder", async ({
	page,
	db,
	seedConversation,
}) => {
	test.setTimeout(120_000);
	const { id } = await seedPhotos(db, seedConversation);
	const url = `${E2E_APP_BASE}/conversation/${id.toString()}`;
	await page.goto(url);
	await expect(page.locator('[data-testid="message-image-tile"][data-shown="true"]')).toHaveCount(
		COUNT
	);

	// Leave and come back: the thumbnails are made, so they come back at once (the harness's own
	// request stubs switch the browser's HTTP cache off, so what is checked is the server's).
	await page.goto(`${E2E_APP_BASE}/`);
	await installRecorder(page);
	await page.goto(url);
	await expect(page.locator('[data-testid="message-image-tile"][data-shown="true"]')).toHaveCount(
		COUNT
	);
	const rec = await recorded(page);
	expect(rec.shimmer).toBe(false);
});
