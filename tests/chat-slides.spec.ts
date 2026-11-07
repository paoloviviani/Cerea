/**
 * Slides artifact (ADR 0111): the model writes a deck through the artifact
 * tool, the panel renders it with reveal.js in the sandbox, the user steps
 * through it, presents it and downloads the PDF.
 */
import { readFile } from "node:fs/promises";
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { Db } from "mongodb";
import type { Page } from "playwright/test";

const TOOL_MODEL = "test-org/artifact-tool";
const PANEL_LABEL = "File panel";

const DECK = [
	"---",
	"title: Team update",
	"theme: cerea-dark",
	"---",
	"",
	'<!-- .slide: class="title" -->',
	"# Team update",
	"",
	"What changed this month",
	"",
	"---",
	"",
	"## Three things",
	"",
	"- Faster onboarding",
	"- Fewer escalations",
	"- One open risk",
	"",
	"Note: Say the numbers once.",
	"",
].join("\n");

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
					identifier: "team-update",
					type: "slides",
					title: "Team update",
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
	await expect(frame.getByRole("heading", { name: "Team update", level: 1 })).toBeVisible({
		timeout: 30_000,
	});
	const counter = panel.getByTestId("slides-counter");
	await expect(counter).toHaveText("1 / 2");

	await panel.getByRole("button", { name: "Next slide" }).click();
	await expect(counter).toHaveText("2 / 2");
	await expect(frame.getByRole("heading", { name: "Three things" })).toBeVisible();
	await expect(frame.getByRole("listitem").filter({ hasText: "One open risk" })).toBeVisible();

	// Speaker notes appear in the drawer
	await panel.getByRole("button", { name: "Speaker notes (N)" }).click();
	await expect(frame.locator(".cerea-notes")).toHaveText("Say the numbers once.");
	await panel.getByRole("button", { name: "Previous slide" }).click();
	await expect(counter).toHaveText("1 / 2");

	// Present: full screen, or the in-page overlay where the browser refuses
	await panel.getByRole("button", { name: "Present full screen" }).click();
	await expect(frame.getByRole("heading", { name: "Team update", level: 1 })).toBeVisible();
	await page.keyboard.press("Escape");

	// The PDF is made in the browser and downloads as a real PDF with a page per slide
	const downloading = page.waitForEvent("download");
	await panel.getByRole("button", { name: "Download PDF" }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("Team-update.pdf");
	const path = await download.path();
	const pdf = (await readFile(path)).toString("latin1");
	expect(pdf.startsWith("%PDF-1.4")).toBe(true);
	expect(pdf).toContain("/Count 2");
});
