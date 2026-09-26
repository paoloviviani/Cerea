/**
 * `table` artifacts (chat side): CSV with a header row grids into a
 * sortable, filterable table with CSV download, and survives a reload.
 */
import { readFile } from "node:fs/promises";
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { Db } from "mongodb";
import type { Page } from "playwright/test";

const TOOL_MODEL = "test-org/artifact-tool";
const PANEL_LABEL = "Artifact panel";

async function useModel(db: Db, session: { sessionId: string }, model: string) {
	await db
		.collection("settings")
		.updateOne({ sessionId: session.sessionId }, { $set: { activeModel: model } });
}

async function send(page: Page, text: string) {
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
}

const CSV_CONTENT = 'name,amount,note\nbravo,20,"second, place"\nalpha,7,first\ncharlie,10,third\n';

test("a table artifact grids, sorts, filters and downloads as CSV", async ({
	page,
	mockOpenAI,
	db,
	session,
}) => {
	await useModel(db, session, TOOL_MODEL);
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_table",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "sales",
					type: "table",
					title: "Sales",
					content: CSV_CONTENT,
				}),
			},
		],
		content: ["Here", " is", " your", " table", "."],
		chunkDelayMs: 10,
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "make me a sales table");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const panel = page.getByLabel(PANEL_LABEL, { exact: true });
	await expect(panel).toBeVisible({ timeout: 30_000 });
	await expect(panel.getByRole("heading", { name: "Sales" })).toBeVisible({ timeout: 30_000 });

	const grid = panel.getByTestId("table-grid");
	await expect(grid).toBeVisible({ timeout: 30_000 });
	// Quoted field with an embedded comma stays one cell.
	await expect(grid.getByRole("cell", { name: "second, place" })).toBeVisible();
	await expect(grid.getByRole("columnheader", { name: /amount/i })).toBeVisible();

	// Sort ascending by amount: alpha (7) first. The header button's
	// accessible name is its text content, not its title.
	const amountHeader = grid.getByRole("button", { name: "amount", exact: true });
	await amountHeader.click();
	await expect(grid.locator('th[aria-sort="ascending"]')).toHaveCount(1);
	const firstCell = grid.locator("tbody tr").first().locator("td").first();
	await expect(firstCell).toHaveText("alpha");
	// Sort descending: bravo (20) first.
	await amountHeader.click();
	await expect(grid.locator("tbody tr").first().locator("td").first()).toHaveText("bravo");

	// Filter to one row, then clear.
	await panel.getByLabel("Filter rows").fill("char");
	await expect(grid.locator("tbody tr")).toHaveCount(1);
	await expect(grid.locator("tbody tr").first().locator("td").first()).toHaveText("charlie");
	await panel.getByLabel("Filter rows").fill("");
	await expect(grid.locator("tbody tr")).toHaveCount(3);

	// CSV download carries the full content under a .csv name.
	const downloadPromise = page.waitForEvent("download");
	await panel.getByRole("button", { name: "Download sales.csv" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe("sales.csv");
	const path = await download.path();
	const bytes = await readFile(path as string, "utf-8");
	expect(bytes).toContain('bravo,20,"second, place"');

	await panel.screenshot({ path: "reports/artifact-table.png" });

	// The table survives a reload (it is derived from the messages): reopen
	// it from its chat card, since the panel does not auto-open off-stream.
	await page.reload();
	await page.locator('[aria-label="Open artifact: Sales"]').click({ timeout: 30_000 });
	const panelAfter = page.getByLabel(PANEL_LABEL, { exact: true });
	await expect(panelAfter.getByTestId("table-grid")).toBeVisible({ timeout: 30_000 });
	await expect(
		panelAfter.getByTestId("table-grid").getByRole("cell", { name: "second, place" })
	).toBeVisible();
});
