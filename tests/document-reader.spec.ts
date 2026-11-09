/**
 * The user chooses the document reader (backlog C97): a default for their chat
 * uploads in their settings, and one per knowledge base in the base's settings,
 * both from the gateway's OCR models (`?include=ocr`), both stored as chosen.
 *
 * The base is a row seeded in Mongo — what is under test is the choice and its
 * saving, not indexing. The user is a real row with a session, as
 * `project-page.spec` does.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import { ObjectId, type Db } from "mongodb";

async function installUserSession(db: Db, sessionId: string): Promise<ObjectId> {
	const now = new Date();
	const { insertedId } = await db.collection("users").insertOne({
		name: "E2E Reader",
		username: "e2e-reader",
		hfUserId: "e2e-reader-sub",
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
			token: { value: "e2e-reader-token", expiresAt: new Date(now.getTime() + 3600 * 1000) },
		},
	});
	await db.collection("settings").updateOne({ sessionId }, { $set: { userId: insertedId } });
	return insertedId;
}

test("choose a default reader for chat uploads and a reader for one knowledge base", async ({
	page,
	db,
	session,
}) => {
	const userId = await installUserSession(db, session.sessionId);

	// The user's default, starting as the deployment's.
	await page.goto(`${E2E_APP_BASE}/settings/application`);
	const mine = page.getByLabel("Read documents with");
	await expect(mine).toBeVisible();
	await expect(mine.getByRole("option", { name: "mistral-ocr-4.1" })).toBeAttached();
	await expect(mine).toHaveValue("");
	const saved = page.waitForResponse(
		(r) => r.url().includes("/api/v2/user/document-reader") && r.request().method() === "PUT"
	);
	await mine.selectOption("mistral-ocr-4.1");
	expect((await saved).ok()).toBe(true);
	await expect
		.poll(async () => (await db.collection("settings").findOne({ userId }))?.documentReader)
		.toBe("mistral-ocr-4.1");
	await page.reload();
	await expect(page.getByLabel("Read documents with")).toHaveValue("mistral-ocr-4.1");

	// One base's own, saved as it is chosen and applying to new uploads only.
	const now = new Date();
	const { insertedId: baseId } = await db.collection("vectorStores").insertOne({
		name: "Handbook",
		ownerId: userId,
		embeddingModel: "test-embedding",
		dimensions: null,
		chunkChars: 1200,
		chunkOverlap: 150,
		shares: [],
		createdAt: now,
		updatedAt: now,
	});
	await page.goto(`${E2E_APP_BASE}/knowledge/${baseId}`);
	const base = page.getByLabel("Read documents with");
	await expect(base).toHaveValue("");
	await expect(page.getByText("Used for files you add from now on")).toBeVisible();
	await base.selectOption("markitdown");
	await expect(page.getByText("New uploads to this base use this reader")).toBeVisible();
	await expect
		.poll(async () => (await db.collection("vectorStores").findOne({ _id: baseId }))?.readerModel)
		.toBe("markitdown");

	await db.collection("vectorStores").deleteMany({ _id: baseId });
});
