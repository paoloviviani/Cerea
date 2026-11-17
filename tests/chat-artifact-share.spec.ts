/**
 * Share links for artifacts (ADR 0120): share a Markdown artifact to anyone,
 * open the link in a fresh browser context (no cookies, no session) and read
 * it under the band, then revoke it and see the link stop working.
 */
import { test, expect, seedConversation, E2E_APP_BASE, E2E_APP_URL } from "./fixtures.ts";
import { ObjectId, type Db } from "mongodb";

async function installUserSession(db: Db, sessionId: string): Promise<ObjectId> {
	const now = new Date();
	const { insertedId } = await db.collection("users").insertOne({
		name: "Ada Sharer",
		username: "ada-sharer",
		hfUserId: "e2e-sharer-sub",
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
		oauth: {
			token: { value: "e2e-sharer-token", expiresAt: new Date(now.getTime() + 3600 * 1000) },
		},
	});
	await db.collection("settings").updateOne({ sessionId }, { $set: { userId: insertedId } });
	return insertedId;
}

test("share a Markdown artifact to anyone, read it in a fresh context, revoke it", async ({
	page,
	browser,
	db,
	session,
}) => {
	const userId = await installUserSession(db, session.sessionId);
	const chat = await seedConversation(db, session.sessionId, {
		title: "Planning chat",
		messages: [
			{ from: "system", content: "" },
			{ from: "user", content: "write the plan" },
			{
				from: "assistant",
				content:
					'Here it is.\n<artifact identifier="plan" type="markdown" title="The plan">\n# Launch plan\n\nShip **on Friday**.\n</artifact>',
			},
		],
		raw: { userId, sessionId: undefined },
	});

	await page.goto(`${E2E_APP_BASE}/conversation/${chat}?artifact=plan`);
	const panel = page.getByLabel("File panel", { exact: true });
	await expect(panel.getByRole("heading", { name: "The plan" })).toBeVisible({ timeout: 30_000 });

	await panel.getByTestId("share-link-button").click();
	const dialog = page.getByTestId("share-dialog");
	await expect(dialog.getByTestId("share-preview")).toContainText("Launch plan");
	await dialog.getByLabel("Anyone with the link").check();
	await expect(dialog.getByTestId("share-notice")).toContainText(
		"Anyone with the link sees exactly this content."
	);
	await dialog.getByRole("button", { name: "Create link" }).click();
	const shared = await dialog.getByLabel("Link", { exact: true }).inputValue();
	expect(shared).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);
	const url = new URL(shared, E2E_APP_URL).toString();

	// A fresh context: no cookie, no session. The content and the band are there.
	const visitor = await browser.newContext();
	const view = await visitor.newPage();
	const response = await view.goto(url);
	expect(response?.status()).toBe(200);
	expect(response?.headers()["set-cookie"]).toBeUndefined();
	await expect(view.getByRole("heading", { name: "Launch plan" })).toBeVisible();
	await expect(view.getByText("Ship")).toBeVisible();
	await expect(view.getByRole("note")).toContainText(/Shared from .+ by Ada Sharer\./);
	expect(await visitor.cookies()).toEqual([]);

	// Settings lists it.
	await page.goto(`${E2E_APP_BASE}/settings/shared-links`);
	await expect(page.getByTestId("shared-link-row")).toHaveCount(1);
	await expect(page.getByTestId("shared-link-row")).toContainText("The plan");

	// Revoke it: the link is not found any more.
	await page.getByRole("button", { name: "Revoke the link to The plan" }).click();
	await expect(page.getByTestId("shared-link-row")).toContainText("Revoked");
	const gone = await view.goto(url);
	expect(gone?.status()).toBe(404);
	await expect(view.getByText("Not available")).toBeVisible();
	await visitor.close();
});
