/**
 * A text attachment too large to inline reaches the model as a sample and a
 * pointer, not whole; the full file is still readable by code at /mnt/data.
 *
 * The mock model records every request, so the first turn's body is checked
 * for what the model was actually sent. The second turn runs a code fence that
 * reads the file at /mnt/data, as chat-attachment-mount.spec.ts does.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

// 22,000 lines, about 281,000 characters: past the threshold (25% of the e2e
// model's 262k-token window, about 262,000 characters) yet under the request body limit.
const LINES = 22_000;
const BODY = Array.from({ length: LINES }, (_, i) => `r${i},${i * 7}`).join("\n") + "\n";

test("a large text attachment is not inlined, and code reads all of it at /mnt/data", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(150_000);
	await mockOpenAI.setDefaultScenario({
		routes: [
			{
				contains: "XYZREAD",
				scenario: {
					content: [
						"Reading:\n\n```python\n" +
							"print('LINES:' + str(len(open('/mnt/data/big.csv').read().splitlines())))\n" +
							"```\n",
					],
					chunkDelayMs: 10,
					finishReason: "stop",
				},
			},
		],
		content: ["Got it."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByLabel("Upload file").setInputFiles({
		name: "big.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(BODY),
	});
	await expect(page.getByText("big.csv")).toBeVisible();
	await page.getByPlaceholder("Ask anything").fill("what is in my file?");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText("Got it.", {
		timeout: 90_000,
	});

	const sent = JSON.stringify((await mockOpenAI.requests()).at(-1)?.body.messages);
	expect(sent).toContain("Large content:");
	expect(sent).toContain(`${LINES} lines`);
	expect(sent).toContain("r0,0");
	expect(sent).not.toContain(`r${LINES / 2},`);
	expect(sent.length).toBeLessThan(60_000);
	// Code is either on offer (the file path is named) or the model is told it is not.
	expect(sent).toMatch(/\/mnt\/data\/big\.csv|code is not available here/);

	// The whole file is in the sandbox for code.
	await page.getByPlaceholder("Ask anything").fill("count the rows XYZREAD");
	await page.getByRole("button", { name: "Send message" }).click();
	const run = page.locator('[data-message-role="assistant"]').last();
	await expect(run).toContainText("Finished", { timeout: 90_000 });
	await expect(run).toContainText(`LINES:${LINES}`);
});
