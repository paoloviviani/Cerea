/**
 * A turn that fails part-way keeps its partial output on screen, with the
 * error below it and two actions. What the user sees and what the model is
 * sent must match: Retry regenerates from scratch (the failed attempt is not
 * replayed), Continue keeps the partial and asks the model to go on, as a
 * user turn (never an assistant prefill: Anthropic models reject one).
 */
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { ScenarioScript } from "./mock-openai.ts";

const SEND = { name: "Send message" };
const PARTIAL = "partial-alpha-text";
const CONTINUE_TEXT = "Continue from where you stopped.";

type Msg = { role: string; content: unknown };

async function firstTurnFails(
	page: Page,
	mockOpenAI: { setDefaultScenario(s: ScenarioScript): Promise<void> }
) {
	await mockOpenAI.setDefaultScenario({
		content: [PARTIAL.slice(0, 8), PARTIAL.slice(8)],
		chunkDelayMs: 10,
		streamError: "mock quota exceeded",
		nonStreamContent: "Failing chat",
	});
	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill("tell me something");
	await page.getByRole("button", SEND).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	const assistant = page.locator('[data-message-role="assistant"]').last();
	await expect(assistant).toContainText(PARTIAL, { timeout: 30_000 });
	await expect(page.getByTestId("turn-failed-reason")).toContainText("mock quota exceeded");
	await expect(page.getByTestId("turn-failed-retry")).toBeVisible();
	await expect(page.getByTestId("turn-failed-continue")).toBeVisible();
	return assistant;
}

async function lastChatRequest(mockOpenAI: {
	requests(): Promise<Array<{ path: string; stream: boolean; body: Record<string, unknown> }>>;
}) {
	const all = (await mockOpenAI.requests()).filter(
		(r) => r.path === "/v1/chat/completions" && r.stream
	);
	return all[all.length - 1].body.messages as Msg[];
}

test("a failed turn shows its partial text; Retry does not send it to the model", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(90_000);
	await firstTurnFails(page, mockOpenAI);

	await mockOpenAI.setDefaultScenario("plainText");
	await page.getByTestId("turn-failed-retry").click();
	const assistant = page.locator('[data-message-role="assistant"]').last();
	await expect(assistant).toContainText("Hello from the mock server.", { timeout: 30_000 });

	const sent = await lastChatRequest(mockOpenAI);
	expect(JSON.stringify(sent)).not.toContain(PARTIAL);
	expect(sent[sent.length - 1].role).toBe("user");
});

test("Continue keeps the partial text and sends it, then a user continue turn", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(90_000);
	await firstTurnFails(page, mockOpenAI);

	await mockOpenAI.setDefaultScenario("plainText");
	await page.getByTestId("turn-failed-continue").click();
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"Hello from the mock server.",
		{ timeout: 30_000 }
	);
	// The partial answer is still on screen above the continuation.
	await expect(page.locator('[data-message-role="assistant"]').first()).toContainText(PARTIAL);

	const sent = await lastChatRequest(mockOpenAI);
	const last = sent[sent.length - 1];
	expect(last.role).toBe("user");
	expect(JSON.stringify(last.content)).toContain(CONTINUE_TEXT);
	const before = sent[sent.length - 2];
	expect(before.role).toBe("assistant");
	expect(JSON.stringify(before.content)).toContain(PARTIAL);
});
