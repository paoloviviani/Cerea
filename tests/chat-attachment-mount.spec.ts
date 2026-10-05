/**
 * A chat attachment is in the code sandbox: a file uploaded in a chat is
 * readable from a code run at /mnt/data/<its name> (src/lib/utils/execution/
 * attachmentMounts.svelte.ts), with no step by the person.
 *
 * Real Pyodide in the browser, same pattern as chat-autorun-final-answer.spec.ts:
 * the mock model answers with one code fence that opens the file, and the block
 * auto-runs. Twice over — in the turn the file was sent (mounted from the bytes
 * the page already holds), and after a reload (fetched through the
 * conversation's own download route, which is also how a later turn gets it).
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

const CSV = "region,total\nnorth,1200\nsouth,3400\n";

test("an uploaded file is readable at /mnt/data/<name> from a code run, now and after a reload", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(150_000);

	await mockOpenAI.setDefaultScenario({
		content: [
			"Reading it:\n\n```python\n" + "print(open('/mnt/data/sales data.csv').read())\n" + "```\n",
		],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByLabel("Upload file").setInputFiles({
		name: "sales data.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(CSV),
	});
	await expect(page.getByText("sales data.csv")).toBeVisible();
	await page.getByPlaceholder("Ask anything").fill("what is in my file?");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const assistant = page.locator('[data-message-role="assistant"]').last();
	await expect(assistant).toContainText("Finished", { timeout: 90_000 });
	await expect(assistant).not.toContainText("FileNotFoundError");
	await expect(assistant).toContainText("north,1200");
	await expect(assistant).toContainText("south,3400");
	// The chip says what the sandbox holds.
	await expect(page.getByText("/mnt/data/sales data.csv")).toBeVisible();

	// A fresh page has a fresh sandbox: the file now comes from the stored copy.
	await page.reload();
	const rerun = page.locator('[data-message-role="assistant"]').last();
	await rerun.getByRole("button", { name: "Run code" }).click();
	await expect(rerun).toContainText("Finished", { timeout: 90_000 });
	await expect(rerun).not.toContainText("FileNotFoundError");
	await expect(rerun).toContainText("south,3400");
	await expect(page.getByText("/mnt/data/sales data.csv")).toBeVisible();
});
