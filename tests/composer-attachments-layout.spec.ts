/**
 * Many attachments must not push the composer off the screen. The owner attached
 * seven portrait photos on a phone and got a grid of large previews with the text
 * box and send button below the fold. The strip is now one compact scrolling row
 * of small tiles inside the composer; the text box and send stay reachable on the
 * empty new-chat page (centred composer) and in an existing conversation, on
 * phones and desktop.
 */
import { test, expect, E2E_APP_BASE, waitForHydration } from "./fixtures.ts";
import type { Locator, Page } from "playwright/test";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc = (buf: Buffer) => {
	let c = 0xffffffff;
	for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type), data]);
	const sum = Buffer.alloc(4);
	sum.writeUInt32BE(crc(body));
	return Buffer.concat([len, body, sum]);
};
/** A portrait (200x300) solid PNG: what a scanned invoice photo looks like to layout. */
function portraitPng(): Buffer {
	const w = 200;
	const h = 300;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 200)]);
	const raw = Buffer.concat(Array.from({ length: h }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** Bounding box of a rendered element; a missing one fails the test. */
async function boxOf(el: Locator) {
	const r = await el.boundingBox();
	if (!r) throw new Error("element has no box");
	return r;
}

const images = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		name: `invoice-${i + 1}.png`,
		mimeType: "image/png",
		buffer: portraitPng(),
	}));
const mixed = (n: number) =>
	Array.from({ length: n }, (_, i) =>
		i % 2 === 0
			? { name: `scan-${i}.png`, mimeType: "image/png", buffer: portraitPng() }
			: {
					name: `statement-with-a-rather-long-file-name-${i}.pdf`,
					mimeType: "application/pdf",
					buffer: Buffer.from("%PDF-1.4\n%%EOF"),
				}
	);

async function expectComposerReachable(page: Page) {
	const box = page.getByPlaceholder("Ask anything");
	await box.fill("here are my invoices");
	const send = page.getByRole("button", { name: "Send message" });
	const vp = page.viewportSize() ?? { width: 0, height: 0 };
	for (const el of [box, send]) {
		await expect(el).toBeVisible();
		const r = await boxOf(el);
		expect(r.y).toBeGreaterThanOrEqual(0);
		expect(r.y + r.height).toBeLessThanOrEqual(vp.height);
		expect(r.x + r.width).toBeLessThanOrEqual(vp.width);
		await el.click({ trial: true });
	}
	// The installed PWA never scrolls the page: nothing may rely on it.
	const doc = await page.evaluate(() => ({
		scrollY: window.scrollY,
		scrollHeight: (document.scrollingElement ?? document.documentElement).scrollHeight,
		innerHeight: window.innerHeight,
	}));
	expect(doc.scrollY).toBe(0);
	expect(doc.scrollHeight).toBeLessThanOrEqual(doc.innerHeight);
	// Thumbnails stay small.
	const thumbs = page.getByTestId("composer-image-thumb");
	for (const t of await thumbs.all()) {
		expect((await boxOf(t)).height).toBeLessThanOrEqual(72);
	}
	const strip = page.getByTestId("composer-file-strip");
	expect((await boxOf(strip)).height).toBeLessThanOrEqual(110);
}

const viewports = [
	{ width: 412, height: 915 },
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 },
];

for (const vp of viewports) {
	test.describe(`${vp.width}x${vp.height}`, () => {
		test.use({ viewport: vp });

		for (const [label, files] of [
			["7 portrait photos", images(7)],
			["12 mixed images and PDFs", mixed(12)],
		] as const) {
			test(`new chat: ${label} keep the text box and send in view`, async ({ page }) => {
				await page.goto(`${E2E_APP_BASE}/`);
				await waitForHydration(page);
				await page.getByLabel("Upload file").setInputFiles(files);
				await expect(page.getByTestId("composer-file-strip")).toBeVisible();
				await expectComposerReachable(page);
			});

			test(`existing conversation: ${label} keep the text box and send in view`, async ({
				page,
				mockOpenAI,
			}) => {
				await mockOpenAI.setDefaultScenario("plainText");
				await page.goto(`${E2E_APP_BASE}/`);
				await waitForHydration(page);
				await page.getByPlaceholder("Ask anything").fill("hello");
				await page.getByRole("button", { name: "Send message" }).click();
				await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
				await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
					"Hello from the mock server."
				);
				await page.getByLabel("Upload file").setInputFiles(files);
				await expect(page.getByTestId("composer-file-strip")).toBeVisible();
				await expectComposerReachable(page);
			});
		}
	});
}
