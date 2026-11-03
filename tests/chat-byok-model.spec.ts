/**
 * A user's own-key model (`my/<name>`, gateway BYOK) in the chat: it comes from their
 * own `/v1/models` (the mock lists it only for their token), shows in the picker with the
 * "Your key" badge, can be picked, and a message on it streams. A user without that token
 * does not see it.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import { MOCK_BYOK_MODEL, MOCK_BYOK_TOKEN } from "./mock-openai.ts";
import type { Db } from "mongodb";

async function signIn(db: Db, sessionId: string, token: string, activeModel?: string) {
	const now = new Date();
	const { insertedId } = await db.collection("users").insertOne({
		name: "E2E Byok",
		username: `e2e-byok-${token}`,
		hfUserId: `e2e-byok-sub-${token}`,
		avatarUrl: undefined,
		createdAt: now,
		updatedAt: now,
	});
	await db.collection("sessions").insertOne({
		sessionId,
		userId: insertedId,
		expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
		createdAt: now,
		updatedAt: now,
		authTime: now,
		oauth: { token: { value: token, expiresAt: new Date(now.getTime() + 3600 * 1000) } },
	});
	await db.collection("settings").updateOne(
		{ sessionId },
		{
			$set: { userId: insertedId, activeModel: activeModel ?? "test-org/test-model" },
		}
	);
}

test("the owner sees their own model with the badge, picks it, and a message streams", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	await signIn(db, session.sessionId, MOCK_BYOK_TOKEN);
	await mockOpenAI.setDefaultScenario({ content: ["Own", " key", " answer."], chunkDelayMs: 5 });
	await page.goto(`${E2E_APP_BASE}/`);

	const search = page.getByRole("textbox", { name: "Search models" });
	await expect(async () => {
		if (!(await search.isVisible()))
			await page.getByRole("button", { name: "Model and effort" }).click();
		await expect(search).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	await search.fill("E2E Llama");
	const row = page.getByRole("menuitem").filter({ hasText: "E2E Llama" });
	await expect(row).toContainText("Your key");
	await row.click();
	await expect(page.getByRole("button", { name: "Model and effort" })).toContainText("E2E Llama");

	await page.getByPlaceholder("Ask anything").fill("hello own key");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.getByText("Own key answer.")).toBeVisible({ timeout: 30_000 });

	const sent = (await mockOpenAI.requests()).filter(
		(r) => r.path === "/v1/chat/completions" && r.body.stream === true
	);
	expect(sent.at(-1)?.body.model).toBe(MOCK_BYOK_MODEL.id);
});

test("another user does not get it", async ({ page, db, session }) => {
	await signIn(db, session.sessionId, "e2e-someone-else");
	await page.goto(`${E2E_APP_BASE}/`);
	const search = page.getByRole("textbox", { name: "Search models" });
	await expect(async () => {
		if (!(await search.isVisible()))
			await page.getByRole("button", { name: "Model and effort" }).click();
		await expect(search).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	await search.fill("E2E Llama");
	await expect(page.getByRole("menuitem").filter({ hasText: "E2E Llama" })).toHaveCount(0);
});
