/**
 * Regression for the auto-run miss when a model streams only its thinking
 * and delivers the whole visible answer — code fence included — in one
 * final chunk (glm-5.3-flash via the gateway, live 2026-09-27). The fence
 * never gets a chance to render while its own `loading` is true (it arrives
 * already closed), so a mark keyed on that flag never fires and the block
 * never auto-runs. See src/lib/components/CodeBlock.svelte's `messageLoading`.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

const SEND = { name: "Send message" };
const RUN = { name: "Run code" };

test("a code fence delivered whole in the final answer, with no streamed answer tokens, still auto-runs exactly once", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(60_000);

	await mockOpenAI.setDefaultScenario({
		// Only the thinking streams token by token...
		reasoning: ["Let me ", "think ", "about ", "this."],
		reasoningField: "reasoning",
		// ...the visible answer, fence included, arrives as ONE chunk: no
		// streamed tokens for the answer itself.
		content: ["Here you go:\n\n```python\nprint('final answer autorun')\n```\n"],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill("give me a one-shot script");
	await page.getByRole("button", SEND).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	// Auto-run fires without the user ever touching Run: the manual button
	// goes disabled (a run is queued/running) on its own.
	const runButton = page.getByRole("button", RUN);
	await expect(runButton).toBeVisible({ timeout: 30_000 });
	await expect(runButton).toBeDisabled({ timeout: 30_000 });

	// And the run actually completes.
	const assistantMessage = page.locator('[data-message-role="assistant"]').last();
	await expect(assistantMessage).toContainText("Finished", { timeout: 30_000 });
	await expect(assistantMessage).toContainText("final answer autorun");

	// A reload afterwards must not re-run it: a history block stays inert.
	await page.reload();
	const reloadedRunButton = page.getByRole("button", RUN);
	await expect(reloadedRunButton).toBeVisible();
	// Give a wrongly-firing auto-run every chance to happen before asserting it didn't.
	await page.waitForTimeout(2_000);
	await expect(reloadedRunButton).toBeEnabled();
	await expect(page.locator('[data-message-role="assistant"]').last()).not.toContainText(
		"Finished"
	);
});
