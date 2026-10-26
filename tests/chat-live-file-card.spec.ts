/**
 * A file a run has just produced, in the tab that ran it, is the linked file
 * artifact card (opens in the side panel), and it is the same card after a
 * reload from what the turn stored. The browser fingerprints the file (sha256)
 * when the sandbox lists it, so the card never waits on an upload, and the
 * turn's record of it survives a reload.
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
				'd = Document()\nd.add_paragraph("Hello world")\nd.save("_rt.docx")\n' +
				'import os\nd.save("/tmp/_rt2.docx")\n' +
				'd.save("/mnt/output/hello_world.docx")\n' +
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

	// The card is the artifact card at once: the file has its identity from the
	// moment the sandbox lists it, and the fence's run is one surface.
	const openButton = assistantMessage.getByRole("button", {
		name: "Open hello_world.docx in panel",
	});
	await expect(openButton).toBeVisible({ timeout: 30_000 });
	await expect(assistantMessage.getByTestId("run-output")).toBeVisible();
	// Scratch files (_rt.docx in the working directory, one in /tmp) are not
	// offered: only the file saved to /mnt/output is a card.
	await expect(assistantMessage.getByTestId("file-artifact-card")).toHaveCount(1);
	await expect(assistantMessage.getByText("_rt.docx")).toHaveCount(0);
	const live = await assistantMessage.getByTestId("file-artifact-card").innerText();
	await page.screenshot({
		path: process.env.FILECARD_SHOT ?? "/var/tmp/artifacts-tmp/live-card.png",
	});

	// Wait for the record to be kept (the page re-syncs the turn), then reload:
	// the card is the same one, from what was stored.
	await page.waitForTimeout(4000);
	await page.reload();
	const reloaded = page.locator('[data-message-role="assistant"]').last();
	await expect(
		reloaded.getByRole("button", { name: "Open hello_world.docx in panel" })
	).toBeVisible({ timeout: 30_000 });
	await expect(reloaded.getByTestId("file-artifact-card")).toHaveCount(1);
	expect(await reloaded.getByTestId("file-artifact-card").innerText()).toBe(live);
});
