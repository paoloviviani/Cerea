/**
 * Pruning old artifact versions (C122): an artifact with three versions, the first one
 * shared. "Delete older versions" removes the second, keeps the shared first and the
 * current third, says what it did, and the shared link still works.
 */
import { test, expect, seedConversation, E2E_APP_BASE, E2E_APP_URL } from "./fixtures.ts";
import { ObjectId, type Db } from "mongodb";

async function installUserSession(db: Db, sessionId: string): Promise<ObjectId> {
	const now = new Date();
	const { insertedId } = await db.collection("users").insertOne({
		name: "Ada Pruner",
		username: "ada-pruner",
		hfUserId: "e2e-pruner-sub",
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
			token: { value: "e2e-pruner-token", expiresAt: new Date(now.getTime() + 3600 * 1000) },
		},
	});
	await db.collection("settings").updateOne({ sessionId }, { $set: { userId: insertedId } });
	return insertedId;
}

const version = (body: string) =>
	`Here.\n<artifact identifier="plan" type="markdown" title="The plan">\n${body}\n</artifact>`;

test("delete older versions keeps the shared one and the current one", async ({
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
			{ from: "assistant", content: version("# Plan one") },
			{ from: "user", content: "again" },
			{ from: "assistant", content: version("# Plan two") },
			{ from: "user", content: "once more" },
			{ from: "assistant", content: version("# Plan three") },
		],
		raw: { userId, sessionId: undefined },
	});

	await page.goto(`${E2E_APP_BASE}/conversation/${chat}?artifact=plan`);
	const panel = page.getByLabel("File panel", { exact: true });
	await expect(panel.getByRole("heading", { name: "Plan three" })).toBeVisible({
		timeout: 30_000,
	});

	// Share version 1 to anyone.
	await panel.getByRole("button", { name: "Previous version" }).click();
	await panel.getByRole("button", { name: "Previous version" }).click();
	await expect(panel.getByRole("heading", { name: "Plan one" })).toBeVisible();
	await panel.getByTestId("share-link-button").click();
	const dialog = page.getByTestId("share-dialog");
	await dialog.getByLabel("Anyone with the link").check();
	await dialog.getByRole("button", { name: "Create link" }).click();
	const shared = await dialog.getByLabel("Link", { exact: true }).inputValue();
	const url = new URL(shared, E2E_APP_URL).toString();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();

	// Back on the current version, delete the older ones.
	await panel.getByRole("button", { name: "Next version" }).click();
	await panel.getByRole("button", { name: "Next version" }).click();
	await expect(panel.getByRole("heading", { name: "Plan three" })).toBeVisible();
	await panel.getByTestId("delete-older-versions").click();
	await expect(page.getByTestId("delete-older-modal")).toContainText(
		"2 older versions of this artifact will be deleted"
	);
	await page.getByTestId("delete-older-confirm").click();
	await expect(panel.getByTestId("delete-older-note")).toHaveText(
		"1 version deleted; 1 kept because they are shared."
	);

	// Version 2 is gone: the older step skips to version 1, and the chat's card for it says so.
	await panel.getByRole("button", { name: "Previous version" }).click();
	await expect(panel.getByRole("heading", { name: "Plan one" })).toBeVisible();
	await expect(page.getByTestId("artifact-card-deleted")).toHaveCount(1);
	await expect(page.getByTestId("artifact-card-deleted")).toContainText("This version was deleted");

	// The shared link still shows version 1.
	const visitor = await browser.newContext();
	const view = await visitor.newPage();
	expect((await view.goto(url))?.status()).toBe(200);
	await expect(view.getByRole("heading", { name: "Plan one" })).toBeVisible();
	await visitor.close();

	// And it is kept across a reload.
	await page.reload();
	await expect(page.getByTestId("artifact-card-deleted")).toHaveCount(1, { timeout: 30_000 });
});
