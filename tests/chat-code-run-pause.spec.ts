/**
 * A page that goes to the background while `execute_code` is still warming up
 * Python (a phone locking its screen) must not lose the run: the server keeps
 * the parked turn waiting past its ordinary deadline, and on return the page
 * restarts the run and the turn finishes with the model having SEEN the output,
 * not the "execution environment unavailable" fallback.
 *
 * The ordinary deadline is shortened for the suite (`CHAT_CODE_EXECUTION_DEADLINE_SECONDS`
 * in playwright.config.ts); the warm-up is held by delaying the Pyodide runtime request.
 */
import { test, expect, E2E_APP_BASE, waitForHydration } from "./fixtures.ts";

const CODE = "print('RESUME' + 'OUT:' + str(6 * 7))";
const DEADLINE_SECONDS = 30;

test("a run paused in the background past the original deadline resumes and the model sees its output", async ({
	page,
	db,
	mockOpenAI,
}) => {
	test.setTimeout(240_000);
	await mockOpenAI.setDefaultScenario({
		routes: [
			{
				// The round after the tool result: the output text is in the request.
				contains: "RESUMEOUT:42",
				scenario: { content: ["Got the output."], chunkDelayMs: 10, finishReason: "stop" },
			},
		],
		toolCalls: [
			{ id: "call_code", name: "execute_code", arguments: JSON.stringify({ code: CODE }) },
		],
		content: ["Running it."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	// Hold the Python runtime: the warm-up is still pending when the page hides.
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await page.context().route("**/pyodide/pyodide.mjs", async (route) => {
		await gate;
		await route.continue();
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	await page.getByPlaceholder("Ask anything").fill("please compute PAUSEDRUN");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const card = page.getByTestId("code-execution-card");
	await expect(card).toBeVisible({ timeout: 60_000 });

	// The page goes to the background.
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "hidden",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});

	// The parked call is extended well past its ordinary deadline.
	await expect
		.poll(
			async () => {
				const row = await db.collection("parkedCalls").findOne({ kind: "code" });
				return row ? row.resumeAt.getTime() - Date.now() : 0;
			},
			{ timeout: 15_000 }
		)
		.toBeGreaterThan(5 * 60_000);

	// Let the ordinary deadline (and a sweep) pass: the turn is still waiting.
	await page.waitForTimeout((DEADLINE_SECONDS + 14) * 1000);
	const waiting = await db.collection("parkedCalls").findOne({ kind: "code" });
	expect(waiting?.status).toBe("waiting");

	// Back in the foreground, with the runtime released.
	release();
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "visible",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});

	const message = page.locator('[data-message-role="assistant"]').last();
	await expect(message).toContainText("Got the output.", { timeout: 120_000 });
	await expect(message).not.toContainText("unavailable");

	const requests = await mockOpenAI.requests();
	const bodies = requests.map((r) => JSON.stringify(r.body));
	expect(bodies.some((b) => b.includes("RESUMEOUT:42") && b.includes('"role":"tool"'))).toBe(true);
	expect(bodies.some((b) => b.includes("gave no answer before the deadline"))).toBe(false);
});
