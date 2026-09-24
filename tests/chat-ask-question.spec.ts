/**
 * `ask_user_question` in an ordinary conversation, not only the ML Assistant preset: the
 * model's call pauses the turn on the question card, the card survives a reload, and the
 * answer resumes the turn with the choice in the tool result the model sees.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

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

	await page.goto(`${E2E_APP_BASE}/`);
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
	// The answered question collapses to what was asked and chosen, and reads the
	// same after a reload, rehydrated from the stored answer.
	await expect(page.getByText("Format → Bullet points").first()).toBeVisible();
	await page.reload();
	await expect(page.getByText("Format → Bullet points").first()).toBeVisible({ timeout: 30_000 });
	// The model saw the choice: the follow-up request carries it in the tool result.
	const requests = await mockOpenAI.requests();
	expect(
		requests.some(
			(r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body).includes("Bullet points")
		)
	).toBe(true);
});

test("a typed answer reaches the model marked as custom, and a model-authored Other is not shown twice", async ({
	page,
	mockOpenAI,
}) => {
	const withOwnOther = {
		questions: [
			{
				...QUESTION.questions[0],
				options: [...QUESTION.questions[0].options, { label: "Other (please specify)" }],
			},
		],
	};
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{ id: "call_ask", name: "ask_user_question", arguments: JSON.stringify(withOwnOther) },
		],
		content: ["A", " haiku", "."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill("summarise this for me");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	const card = page.getByRole("group", { name: "Question from the assistant" });
	await expect(card).toBeVisible({ timeout: 30_000 });
	// The card's own free-text choice is the only catch-all: the model's is dropped.
	await expect(card.getByRole("button", { name: /Other \(please specify\)/ })).toHaveCount(0);
	await expect(card.getByRole("button", { name: /Something else/ })).toHaveCount(1);

	await card.getByRole("button", { name: /Something else/ }).click();
	await card.getByRole("textbox", { name: "Your own answer" }).fill("A haiku");
	await card.getByRole("button", { name: "Send" }).click();

	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText("A haiku.", {
		timeout: 30_000,
	});
	await expect(page.getByText("Format → Other: A haiku").first()).toBeVisible();

	// The tool result tells the model this was typed, not one of its options.
	const requests = await mockOpenAI.requests();
	const followUp = requests
		.filter((r) => r.path === "/v1/chat/completions")
		.map((r) => JSON.stringify(r.body))
		.find((body) => body.includes("A haiku"));
	expect(followUp).toBeDefined();
	expect(followUp).toContain("custom, not one of your options");
	expect(followUp).not.toContain("A: chose");
});
