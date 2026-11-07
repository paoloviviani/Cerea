/**
 * Slides artifact (ADR 0111): the model writes a deck through the artifact
 * tool, the panel renders it with reveal.js in the sandbox, the user steps
 * through it, presents it and downloads the PDF.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { Db } from "mongodb";
import type { Page } from "playwright/test";

const TOOL_MODEL = "test-org/artifact-tool";
const PANEL_LABEL = "File panel";

// A designed HTML deck (dark gradients, cards, a flow diagram, a table, speaker notes)
const DECK = readFileSync(
	new URL("../src/lib/utils/slides/fixtures/talk-deck.html", import.meta.url),
	"utf8"
);

async function useModel(db: Db, session: { sessionId: string }, model: string) {
	await db
		.collection("settings")
		.updateOne({ sessionId: session.sessionId }, { $set: { activeModel: model } });
}

async function send(page: Page, text: string) {
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
}

test("a slides artifact renders, steps, presents and downloads a PDF", async ({
	page,
	mockOpenAI,
	db,
	session,
}) => {
	await useModel(db, session, TOOL_MODEL);
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_deck",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "quarterly-review",
					type: "slides",
					title: "Quarterly review",
					content: DECK,
				}),
			},
		],
		content: ["Here", " is", " the", " deck", "."],
		chunkDelayMs: 10,
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "make me slides about the team update");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const panel = page.getByLabel(PANEL_LABEL, { exact: true });
	await expect(panel).toBeVisible({ timeout: 30_000 });
	// Let the turn finish first: the draft hands over to the saved version, which can reload the frame
	await expect(page.getByText("Here is the deck.")).toBeVisible({ timeout: 30_000 });
	const frame = panel.frameLocator("iframe[title='Slides']");
	await expect(
		frame.getByRole("heading", { name: "Fewer escalations, faster onboarding", level: 1 })
	).toBeVisible({
		timeout: 30_000,
	});
	const counter = panel.getByTestId("slides-counter");
	await expect(counter).toHaveText("1 / 5");

	await panel.getByRole("button", { name: "Next slide" }).click();
	await expect(counter).toHaveText("2 / 5");
	await expect(frame.getByRole("heading", { name: "Three things to remember" })).toBeVisible();
	await expect(frame.locator(".card p").filter({ hasText: "one open risk" })).toBeVisible();

	// Speaker notes appear in the drawer
	await panel.getByRole("button", { name: "Speaker notes (N)" }).click();
	await expect(frame.locator(".cerea-notes")).toHaveText(
		"Revenue first, because it frames the rest. Support load fell because of the new onboarding flow, covered on the next slide."
	);
	await panel.getByRole("button", { name: "Previous slide" }).click();
	await expect(counter).toHaveText("1 / 5");

	// Present: full screen, or the in-page overlay where the browser refuses
	await panel.getByRole("button", { name: "Present full screen" }).click();
	await expect(
		frame.getByRole("heading", { name: "Fewer escalations, faster onboarding", level: 1 })
	).toBeVisible();
	// Leave: the browser's own full screen, or the overlay's exit button
	await page.evaluate(() => (document.fullscreenElement ? document.exitFullscreen() : undefined));
	const exit = page.getByRole("button", { name: "Exit presentation" });
	if (await exit.isVisible()) await exit.click();

	// The stack has a renderer, so the PDF button makes the vector PDF on the server:
	// a page per slide, with text that can be selected
	const serverPdf = page.waitForEvent("download");
	await panel.getByRole("button", { name: "PDF", exact: true }).click();
	const vector = await serverPdf;
	expect(vector.suggestedFilename()).toBe("Fewer-escalations-faster-onboarding.pdf");
	const parsed = await readPdf(await vector.path());
	expect(parsed.pages).toBe(5);
	expect(parsed.text).toContain("Fewer escalations");
	expect(parsed.text).toContain("Revenue growth");

	// "Print or save as PDF" opens reveal's print layout in a tab of its own, sandboxed by its headers
	const printTab = page.context().waitForEvent("page");
	const printResponse = page
		.context()
		.waitForEvent("response", (r) => r.url().includes("/api/v2/slides/print"));
	await panel.getByRole("button", { name: "More ways to make a PDF" }).click();
	await panel.getByRole("menuitem", { name: "Print or save as PDF" }).click();
	const tab = await printTab;
	const response = await printResponse;
	const csp = (await response.allHeaders())["content-security-policy"] ?? "";
	expect(csp).toContain("sandbox allow-scripts allow-modals");
	expect(csp).not.toContain("allow-same-origin");
	await tab.waitForSelector("html[data-print-ready]", { state: "attached" });
	await expect(tab.locator(".pdf-page")).toHaveCount(5);
	// An opaque origin: the app's cookies and storage are out of reach
	await expect(tab.evaluate(() => document.cookie)).rejects.toThrow(/sandbox|SecurityError/i);
	await tab.close();

	// The picture PDF is the last option: made in the browser, a page per slide
	const downloading = page.waitForEvent("download");
	await panel.getByRole("button", { name: "More ways to make a PDF" }).click();
	await panel.getByRole("menuitem", { name: /as pictures/ }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("Fewer-escalations-faster-onboarding.pdf");
	const pdf = (await readFile(await download.path())).toString("latin1");
	expect(pdf.startsWith("%PDF-1.4")).toBe(true);
	expect(pdf).toContain("/Count 5");
});

const MATH_DECK = [
	"<section>Intro $E=mc^2$ and it costs $5 and $10 in total</section>",
	"<section><section>Stack a</section><section>Stack b $\\ce{H2O}$</section></section>",
	"<section>$$\\int_0^1 x\\,dx = \\tfrac12$$</section>",
].join("\n");

test("@smoke the server PDF counts vertical slides and keeps math as text", async ({
	page,
	mockOpenAI,
	db,
	session,
}) => {
	await useModel(db, session, TOOL_MODEL);
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_math",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "math-deck",
					type: "slides",
					title: "Math deck",
					content: MATH_DECK,
				}),
			},
		],
		content: ["Here is the math deck."],
		chunkDelayMs: 10,
	});
	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "slides with a formula");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.getByText("Here is the math deck.")).toBeVisible({ timeout: 30_000 });
	const panel = page.getByLabel(PANEL_LABEL, { exact: true });
	await expect(panel.getByTestId("slides-counter")).toHaveText("1 / 4", { timeout: 30_000 });
	const serverPdf = page.waitForEvent("download");
	await panel.getByRole("button", { name: "PDF", exact: true }).click();
	const parsed = await readPdf(await (await serverPdf).path());
	expect(parsed.pages).toBe(4);
	expect(parsed.text).toContain("Stack a");
	expect(parsed.text).toContain("Stack b");
	// Currency stayed text; the formula became real glyphs
	expect(parsed.text).toContain("costs $5 and $10");
	expect(parsed.text.replace(/\s+/g, "")).toContain("mc");
});

/** Page count and the text of a PDF, read the way a viewer would. */
async function readPdf(path: string): Promise<{ pages: number; text: string }> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const doc = await pdfjs.getDocument({
		data: new Uint8Array(await readFile(path)),
		useSystemFonts: true,
	}).promise;
	let text = "";
	for (let i = 1; i <= doc.numPages; i++) {
		const content = await (await doc.getPage(i)).getTextContent();
		text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
	}
	return { pages: doc.numPages, text };
}
