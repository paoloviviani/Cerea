/**
 * A file a run has just produced, in the tab that ran it, is the linked file
 * artifact card (opens in the side panel) and not the plain file card. The
 * live run's own listing carries no sha256, so the card used to stay plain
 * for as long as the tab held the run; only a reload turned it into the
 * artifact card.
 *
 * Real Pyodide in the browser: the model's answer (fence included) arrives
 * in one chunk and the block auto-runs, as in chat-autoinstall-imports.spec.ts.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

test("a freshly produced file is an artifact card without a reload", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(120_000);

	await mockOpenAI.setDefaultScenario({
		content: [
			"Here you go:\n\n```python\n" +
				"from docx import Document\n" +
				'd = Document()\nd.add_paragraph("Hello world")\nd.save("hello_world.docx")\n' +
				"```\n",
		],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill("create a hello world docx");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const assistantMessage = page.locator('[data-message-role="assistant"]').last();
	await expect(assistantMessage).toContainText("Finished", { timeout: 60_000 });
	await expect(assistantMessage.getByText("hello_world.docx", { exact: true })).toBeVisible({
		timeout: 10_000,
	});

	// Once the upload and the record land, the card is the artifact card.
	await expect(
		assistantMessage.getByRole("button", { name: "Open hello_world.docx in panel" })
	).toBeVisible({ timeout: 30_000 });
	await page.screenshot({
		path: process.env.FILECARD_SHOT ?? "/var/tmp/filecard-tmp/live-card.png",
	});
});
