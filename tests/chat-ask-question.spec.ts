/**
 * `ask_user_question` in an ordinary conversation, not only the ML Assistant preset: the
 * model's call pauses the turn on the question card, the card survives a reload, and the
 * answer resumes the turn with the choice in the tool result the model sees.
 */
import { test, expect } from "./fixtures.ts";

const QUESTION = {
	questions: [
		{
			question: "Which format should the summary use?",
			header: "Format",
			multiSelect: false,
			options: [
				{ label: "Bullet points", description: "Short, scannable" },
				{ label: "One paragraph", description: "Prose" },
			],
		},
	],
};

test("a question card pauses the turn, survives a reload, and the answer resumes it", async ({
	page,
	mockOpenAI,
}) => {
	await mockOpenAI.setDefaultScenario({
		toolCalls: [{ id: "call_ask", name: "ask_user_question", arguments: JSON.stringify(QUESTION) }],
		content: ["Here", " are", " the", " bullets", "."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto("/");
	await page.getByPlaceholder("Ask anything").fill("summarise this for me");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const card = page.getByRole("group", { name: "Question from the assistant" });
	await expect(card).toBeVisible({ timeout: 30_000 });
	await expect(card).toContainText("Which format should the summary use?");

	// The question is durable: a reload brings the same card back, still unanswered.
	await page.reload();
	await expect(card).toBeVisible({ timeout: 30_000 });

	await card.getByRole("button", { name: /Bullet points/ }).click();
	await card.getByRole("button", { name: "Send" }).click();

	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"Here are the bullets.",
		{ timeout: 30_000 }
	);
	// The model saw the choice: the follow-up request carries it in the tool result.
	const requests = await mockOpenAI.requests();
	expect(
		requests.some(
			(r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body).includes("Bullet points")
		)
	).toBe(true);
});
