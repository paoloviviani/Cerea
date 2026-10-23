/* eslint-disable @typescript-eslint/no-non-null-assertion -- assertions on values the test just created */
/**
 * Produced files after a reload, from what the turn stored: the one card
 * family, on a phone and on a desktop, and the previews it opens (pdf.js for
 * a PDF, pptx-glimpse for a deck, the same on both).
 *
 * The bugs this pins slipped through unit tests because they live between
 * layers: a stored turn rendered by the real build, in a real browser, at
 * phone width.
 */
import type { Db, ObjectId } from "mongodb";
import { devices } from "playwright/test";
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import {
	codeRunUpdates,
	finalAnswer,
	helloPptx,
	pdfBytes,
	seedStoredFile,
	setUpdates,
	unsavedRef,
} from "./fileCardSeed.ts";

test.use({
	...devices["Pixel 7"],
	viewport: { width: 390, height: 1400 },
});

type SeedFn = (input: {
	title?: string;
	messages?: Array<{ from: "system" | "user" | "assistant"; content: string }>;
}) => Promise<ObjectId>;

async function seedTurn(db: Db, seedConversation: SeedFn) {
	const cid = await seedConversation({
		title: "Files",
		messages: [
			{ from: "system", content: "" },
			{ from: "user", content: "make files" },
			{ from: "assistant", content: "Here they are." },
		],
	});
	const pdf = await seedStoredFile(db, cid, "report.pdf", pdfBytes(2));
	const deck = await seedStoredFile(
		db,
		cid,
		"preview_Cerea_and_Pystino_Overview_final.pptx",
		helloPptx()
	);
	const a = await seedStoredFile(db, cid, "a/x.csv", Buffer.from("a,b\n1,2\n"));
	const b = await seedStoredFile(db, cid, "b/x.csv", Buffer.from("a,b\n3,4\n"));
	const lost = unsavedRef("lost_results.xlsx");
	await setUpdates(db, cid, 2, [
		...codeRunUpdates("exec-1", { files: [pdf, deck, a, b, lost] }),
		finalAnswer("Here they are."),
	]);
	return cid;
}

test("a stored run shows one header and the same card for every file, at phone width", async ({
	page,
	db,
	seedConversation,
}) => {
	const cid = await seedTurn(db, seedConversation);
	await page.goto(`${E2E_APP_BASE}/conversation/${cid}`);
	const message = page.locator('[data-message-role="assistant"]').last();

	// One header row, the run's own label; no separate tool line.
	await expect(message.getByText("Ran Python")).toBeVisible();
	await expect(message).not.toContainText("Called tool");
	await expect(message).not.toContainText("execute_code");

	// Files are visible with the code folded, as rows of one surface.
	const cards = message.getByTestId("file-artifact-card");
	await expect(cards).toHaveCount(5);
	const surface = message.getByTestId("code-execution-card");
	// The surface stays inside the message column on a phone (a minimum width
	// wider than the column once pushed it out on the right).
	const column = await message.boundingBox();
	const frame = await surface.boundingBox();
	expect(frame!.x + frame!.width).toBeLessThanOrEqual(column!.x + column!.width + 1);
	expect(frame!.x).toBeGreaterThanOrEqual(column!.x - 1);
	for (let i = 0; i < 5; i++) {
		const box = await cards.nth(i).boundingBox();
		const outer = await surface.boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(outer!.x);
		expect(box!.x + box!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 1);
	}

	// Same basename in two directories: two files, each with its directory.
	await expect(message.getByText("a/ · Spreadsheet")).toBeVisible();
	await expect(message.getByText("b/ · Spreadsheet")).toBeVisible();

	// A long name keeps its extension on one line and its full name in the tooltip.
	const long = message.getByTestId("file-name").filter({ hasText: "final.pptx" });
	await expect(long).toBeVisible();
	await expect(long).toHaveAttribute("title", "preview_Cerea_and_Pystino_Overview_final.pptx");
	const lineBox = await long.boundingBox();
	expect(lineBox!.height).toBeLessThan(26);
	// The name gets real room (a shrink-wrapped surface once squeezed it to nothing
	// and left only the extension visible).
	expect(lineBox!.width).toBeGreaterThan(120);
	const head = await long.locator("span").first().boundingBox();
	expect(head!.width).toBeGreaterThan(60);

	// A file whose save failed says so instead of vanishing.
	await expect(message.getByTestId("file-not-saved")).toContainText("no longer available");

	// Phone: actions are icon-only but still named.
	await expect(message.getByRole("button", { name: "Download report.pdf" })).toBeVisible();
	const label = await message
		.getByRole("button", { name: "Download report.pdf" })
		.evaluate((el: HTMLElement) => el.innerText.trim());
	expect(label).toBe("");

	// No horizontal overflow of the page.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("a PDF opens drawn in the panel by pdf.js on a phone, not as a new-tab dead end", async ({
	page,
	db,
	seedConversation,
}) => {
	const cid = await seedTurn(db, seedConversation);
	await page.goto(`${E2E_APP_BASE}/conversation/${cid}`);
	const message = page.locator('[data-message-role="assistant"]').last();
	// A click before the page has hydrated does nothing: click until the panel is there.
	await expect(async () => {
		await message.getByRole("button", { name: "Open report.pdf in panel" }).click();
		await expect(page.getByTestId("pdf-viewer")).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 30_000 });

	const pages = page.getByTestId("pdf-viewer").locator("canvas");
	await expect(pages).toHaveCount(2, { timeout: 30_000 });
	await expect(page.getByText("opens in the browser's PDF viewer")).toHaveCount(0);
	// The canvas has real pixels (the text "Page 1" is dark on white).
	const dark = await pages.first().evaluate((canvas: HTMLCanvasElement) => {
		const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
		for (let i = 0; i < data.length; i += 4) if (data[i] < 100) return true;
		return false;
	});
	expect(dark).toBe(true);
	// The secondary actions exist.
	await expect(page.getByRole("button", { name: "Open report.pdf in a new tab" })).toBeVisible();
});

test("a deck opens as slide images on a phone", async ({ page, db, seedConversation }) => {
	test.setTimeout(120_000);
	const cid = await seedTurn(db, seedConversation);
	await page.goto(`${E2E_APP_BASE}/conversation/${cid}`);
	const message = page.locator('[data-message-role="assistant"]').last();
	await expect(async () => {
		await message
			.getByRole("button", { name: /Open preview_Cerea_and_Pystino_Overview_final.pptx in panel/ })
			.click();
		await expect(page.getByLabel(/Close|close/).first()).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 30_000 });
	await expect(page.locator('[data-testid="pptx-slides"] img').first()).toBeVisible({
		timeout: 60_000,
	});
});

test("a failed run keeps its error readable with the code folded", async ({
	page,
	db,
	seedConversation,
}) => {
	const cid = await seedConversation({
		title: "Failed",
		messages: [
			{ from: "system", content: "" },
			{ from: "user", content: "break" },
			{ from: "assistant", content: "It failed." },
		],
	});
	await setUpdates(db, cid, 2, [
		...codeRunUpdates("exec-err", { ok: false, error: "ValueError: slide layout 9 out of range" }),
		finalAnswer("It failed."),
	]);
	await page.goto(`${E2E_APP_BASE}/conversation/${cid}`);
	const message = page.locator('[data-message-role="assistant"]').last();
	await expect(message.getByTestId("run-error")).toContainText("slide layout 9 out of range");
	await expect(message.getByText("Failed", { exact: true })).toBeVisible();
});
