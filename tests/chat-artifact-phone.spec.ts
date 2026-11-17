/**
 * Artifacts on a phone: the panel is a fullscreen overlay that covers the
 * chat, so a new artifact version must not open it by itself. The card shows
 * the latest version and a tap opens it.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { Db } from "mongodb";
import type { Page } from "playwright/test";

const TOOL_MODEL = "test-org/artifact-tool";
const PANEL_LABEL = "File panel";

async function useModel(db: Db, session: { sessionId: string }, model: string) {
	await db
		.collection("settings")
		.updateOne({ sessionId: session.sessionId }, { $set: { activeModel: model } });
}

async function send(page: Page, text: string) {
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
}

test("on a phone, new artifact versions leave the chat visible until a tap opens the latest", async ({
	page,
	mockOpenAI,
	db,
	session,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await useModel(db, session, TOOL_MODEL);
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_v1",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "landing",
					type: "html",
					title: "Landing page",
					content: "<h1>Landing</h1><p>Version one.</p>",
				}),
			},
		],
		content: ["First", " done", "."],
		chunkDelayMs: 10,
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "build a landing page");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	// The turn finishes with the chat on screen and the panel never shown.
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"First done.",
		{ timeout: 30_000 }
	);
	const panel = page.getByLabel(PANEL_LABEL, { exact: true });
	await expect(panel).toHaveCount(0);

	// A second turn makes version two; the chat is still not covered.
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_v2",
				name: "artifact",
				arguments: JSON.stringify({
					command: "update",
					identifier: "landing",
					old_str: "Version one.",
					new_str: "Version two.",
				}),
			},
		],
		content: ["Second", " done", "."],
		chunkDelayMs: 10,
	});
	await send(page, "make it version two");
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"Second done.",
		{ timeout: 30_000 }
	);
	await expect(panel).toHaveCount(0);

	// Both versions are cards; the newest carries the "Updated" hint.
	const cards = page.locator('[aria-label="Open file: Landing page"]');
	await expect(cards).toHaveCount(2);
	await expect(page.getByTestId("artifact-card-updated")).toHaveCount(1);
	await expect(panel).toHaveCount(0);

	// A tap opens the latest version.
	await cards.last().click();
	await expect(panel).toBeVisible({ timeout: 30_000 });
	await expect(panel).toContainText("Landing page");
});
