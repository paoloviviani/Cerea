/**
 * The composer's model/effort pill: search and pick a model, and set a
 * thinking effort per conversation (a new chat's pick is the person's
 * default for that model). The effort reaches the upstream request as
 * `reasoning_effort`.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { Db } from "mongodb";
import type { Page } from "playwright/test";

const THINKING = "test-org/thinking-model";

async function useModel(db: Db, session: { sessionId: string }, model: string) {
	await db
		.collection("settings")
		.updateOne({ sessionId: session.sessionId }, { $set: { activeModel: model } });
}

async function send(page: Page, text: string) {
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
}

async function pickEffort(page: Page, level: string) {
	await page.getByRole("button", { name: "Model and effort" }).click();
	await page.getByRole("menuitem", { name: /Effort/ }).click();
	await page.getByRole("menuitem", { name: level, exact: true }).click();
}

async function lastEffortSent(mockOpenAI: {
	requests(): Promise<Array<{ path: string; body: Record<string, unknown> }>>;
}) {
	const chats = (await mockOpenAI.requests()).filter(
		(r) => r.path === "/v1/chat/completions" && r.body.model === THINKING && r.body.stream === true
	);
	return chats.at(-1)?.body.reasoning_effort;
}

test("effort is set on the pill, sent upstream, and kept per conversation", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	await useModel(db, session, THINKING);
	await mockOpenAI.setDefaultScenario({ content: ["Thought", " it", " over."], chunkDelayMs: 5 });
	await page.goto(`${E2E_APP_BASE}/`);

	const pill = page.getByRole("button", { name: "Model and effort" });
	await expect(pill).toContainText("Default");
	// On a new chat, the pick is the default new chats with this model start on.
	await pickEffort(page, "High");
	await expect(pill).toContainText("High");

	await send(page, "think hard");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.getByText("Thought it over.")).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => lastEffortSent(mockOpenAI)).toBe("high");

	// In the conversation, the pick is this conversation's own.
	await pickEffort(page, "Low");
	await expect(pill).toContainText("Low");
	await send(page, "think less");
	await expect(page.getByText("Thought it over.").nth(1)).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => lastEffortSent(mockOpenAI)).toBe("low");

	await page.reload();
	await expect(page.getByRole("button", { name: "Model and effort" })).toContainText("Low", {
		timeout: 30_000,
	});

	// A new chat still starts on the person's default, not this conversation's.
	await page.goto(`${E2E_APP_BASE}/`);
	await expect(page.getByRole("button", { name: "Model and effort" })).toContainText("High");
});

test("the pill searches models and switches the conversation's model", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	await useModel(db, session, THINKING);
	await mockOpenAI.setDefaultScenario({ content: ["Hello."], chunkDelayMs: 5 });
	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "hi");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.getByText("Hello.")).toBeVisible({ timeout: 30_000 });

	await page.getByRole("button", { name: "Model and effort" }).click();
	await page.getByRole("textbox", { name: "Search models" }).fill("text input only");
	await expect(page.getByRole("menuitem").first()).toContainText("text-only");
	await page.getByRole("menuitem").first().click();

	// A model without effort: the pill drops the effort half.
	await expect(page.getByRole("button", { name: "Model and effort" })).toContainText("text-only", {
		timeout: 30_000,
	});
	await expect(page.getByRole("button", { name: "Model and effort" })).not.toContainText("Default");

	// "More models" still opens the full picker.
	await page.getByRole("button", { name: "Model and effort" }).click();
	await page.getByRole("menuitem", { name: "More models" }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
});

test("the pill's checkmark lands on the active model on first open, including a new chat's default", async ({
	page,
}) => {
	// No `useModel` call: this session's `activeModel` is the fixture's own
	// default (`test-org/test-model`), exactly the "new conversation, no
	// explicit choice yet" case the /code picker got wrong.
	await page.goto(`${E2E_APP_BASE}/`);

	await page.getByRole("button", { name: "Model and effort" }).click();
	// A query matching every fixture model's `test-org/…` id lists them all,
	// current first — enough rows to tell "checked" from "unchecked" apart.
	await page.getByRole("textbox", { name: "Search models" }).fill("test-org");

	// The search-result rows only — "More models" is its own always-present
	// menu item, not one of the search hits.
	const rows = page.getByRole("menuitem").filter({ hasNotText: "More models" });
	await expect(rows).toHaveCount(5);

	const activeRow = rows.filter({ hasText: "test-org/test-model" });
	await expect(activeRow).toHaveCount(1);
	await expect(activeRow.locator("svg")).toHaveCount(1);

	const otherRows = rows.filter({ hasNotText: "test-org/test-model" });
	await expect(otherRows).toHaveCount(4);
	for (const row of await otherRows.all()) {
		await expect(row.locator("svg")).toHaveCount(0);
	}
});
