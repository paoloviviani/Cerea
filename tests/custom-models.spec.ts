/**
 * Custom models, end to end: make one on the Customize models tab, pick it in
 * a new chat, send a message, and read what the upstream was actually sent.
 *
 * The assertion that matters is on the mock upstream's recorded request: the
 * model is the BASE model's id (the custom id never leaves Cerea) and the
 * system message carries the global prompt, then the custom model's, in order.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

const BASE = "test-org/thinking-model";
const GLOBAL_PROMPT = "GLOBAL-PROMPT: always answer in one sentence.";
const CUSTOM_PROMPT = "CUSTOM-PROMPT: you are the menu helper.";

test("a custom model is created, picked in a new chat, and runs on its base with both prompts", async ({
	page,
	mockOpenAI,
}) => {
	await mockOpenAI.setDefaultScenario({ content: ["Soup", " it", " is."], chunkDelayMs: 5 });

	await page.goto(`${E2E_APP_BASE}/workspace?tab=custom`);
	await expect(page.getByRole("heading", { name: "Customize models", level: 2 })).toBeVisible();

	// The global prompt.
	await page.getByRole("textbox", { name: "Global system prompt" }).fill(GLOBAL_PROMPT);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Saved")).toBeVisible();

	// A custom model on the thinking model.
	await page.getByRole("button", { name: "New custom model" }).first().click();
	await page.getByLabel("Name").fill("Menu helper");
	await page.getByLabel("Base model").selectOption(BASE);
	await page.getByLabel("System prompt").fill(CUSTOM_PROMPT);
	await page.getByRole("button", { name: "Create custom model" }).click();
	await expect(page.getByTestId("custom-model-card")).toContainText("Menu helper");

	// A new chat: the pill offers it beside the base models, marked custom.
	await page.goto(`${E2E_APP_BASE}/`);
	const pill = page.getByRole("button", { name: "Model and effort" });
	await pill.click();
	const row = page.getByRole("menuitem").filter({ hasText: "Menu helper" });
	await expect(row).toContainText("custom");
	await expect(
		page.getByRole("menuitem").filter({ hasText: "test-org/" }).filter({ hasNotText: "custom" })
	).toHaveCount(5);
	await row.click();
	await expect(pill).toContainText("Menu helper");

	await page.getByPlaceholder("Ask anything").fill("what is for lunch?");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.getByText("Soup it is.")).toBeVisible({ timeout: 30_000 });

	// What the upstream received.
	await expect
		.poll(async () => {
			const chats = (await mockOpenAI.requests()).filter(
				(r) => r.path === "/v1/chat/completions" && r.body.stream === true
			);
			return chats.length;
		})
		.toBeGreaterThan(0);
	const requests = (await mockOpenAI.requests()).filter((r) => r.path === "/v1/chat/completions");
	for (const request of requests) {
		expect(request.body.model, "the custom id must never reach the upstream").toBe(BASE);
		expect(JSON.stringify(request.body)).not.toContain("custom:");
	}
	const turn = requests.find((r) => JSON.stringify(r.body.messages).includes("what is for lunch?"));
	const messages = turn?.body.messages as Array<{ role: string; content: string }>;
	const system = messages.find((m) => m.role === "system")?.content ?? "";
	const global = system.indexOf(GLOBAL_PROMPT);
	const custom = system.indexOf(CUSTOM_PROMPT);
	expect(global).toBeGreaterThanOrEqual(0);
	expect(custom).toBeGreaterThan(global);

	// The conversation keeps the custom model: it is still the pill's choice.
	await page.reload();
	await expect(page.getByRole("button", { name: "Model and effort" })).toContainText(
		"Menu helper",
		{ timeout: 30_000 }
	);
});
