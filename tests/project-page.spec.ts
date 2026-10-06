/**
 * A project is a page: create it, attach a knowledge base afterwards (the
 * overlay had no way to), add a context document and see its size, and take a
 * chat out of the project.
 *
 * The knowledge base is a row seeded in Mongo — building one would need the
 * embedding pipeline, and what is under test is the page's attach, not
 * indexing. The user is a real row with a session, as `knowledge-screen.spec`
 * does, because projects need an account.
 */
import { test, expect, seedConversation, E2E_APP_BASE } from "./fixtures.ts";
import { ObjectId, type Db } from "mongodb";

async function installUserSession(db: Db, sessionId: string): Promise<ObjectId> {
	const now = new Date();
	const { insertedId } = await db.collection("users").insertOne({
		name: "E2E Owner",
		username: "e2e-owner",
		hfUserId: "e2e-owner-sub",
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
			token: { value: "e2e-owner-token", expiresAt: new Date(now.getTime() + 3600 * 1000) },
		},
	});
	await db.collection("settings").updateOne({ sessionId }, { $set: { userId: insertedId } });
	return insertedId;
}

const NOTE = "# Call text\n\nEligible costs include travel.";

test("create a project on its page, attach a base afterwards, add a document, remove a chat", async ({
	page,
	db,
	session,
}) => {
	const userId = await installUserSession(db, session.sessionId);

	// Create.
	await page.goto(`${E2E_APP_BASE}/projects/new`);
	await page.getByLabel("Name").fill("E2E project");
	await page.getByLabel("Standing instructions").fill("Answer briefly.");
	await page.getByRole("button", { name: "Create project" }).click();
	await page.waitForURL(/\/projects\/[a-f0-9]{24}$/);
	const projectId = page.url().split("/").pop() ?? "";
	await expect(page.getByRole("heading", { level: 1 })).toContainText("E2E project");
	const created = await db.collection("projects").findOne({ _id: new ObjectId(projectId) });
	expect(created?.instructions).toBe("Answer briefly.");
	expect(created?.knowledgeBaseIds).toEqual([]);

	// The five levels are explained, in order.
	const levels = page.locator("[aria-labelledby='project-levels'] li");
	await expect(levels).toHaveCount(5);
	await expect(levels.nth(1)).toContainText("Context documents");

	// Attach a knowledge base that exists only now.
	const now = new Date();
	await db.collection("vectorStores").insertOne({
		_id: new ObjectId(),
		name: "Call texts",
		ownerId: userId,
		embeddingModel: "",
		dimensions: null,
		chunkChars: 1000,
		chunkOverlap: 100,
		shares: [],
		createdAt: now,
		updatedAt: now,
	});
	await page.reload();
	await page.getByRole("button", { name: "Attach Call texts" }).click();
	await expect(page.getByText("Knowledge bases (1)")).toBeVisible();
	await expect(page.getByRole("button", { name: "Detach Call texts" })).toBeVisible();
	await expect
		.poll(async () => {
			const row = await db.collection("projects").findOne({ _id: new ObjectId(projectId) });
			return row?.knowledgeBaseIds?.length;
		})
		.toBe(1);

	// A context document, listed with its size.
	await page.getByTestId("project-documents-input").setInputFiles({
		name: "call.md",
		mimeType: "text/markdown",
		buffer: Buffer.from(NOTE),
	});
	const docs = page.getByTestId("project-documents");
	await expect(docs.getByText("call.md")).toBeVisible();
	await expect(docs.getByText(`${NOTE.length} characters`)).toBeVisible();
	await expect(docs.getByText(`${NOTE.length} of 100,000 characters`)).toBeVisible();
	expect(await db.collection("projectDocuments").countDocuments({ name: "call.md" })).toBe(1);

	// A chat, removed from the project and kept.
	const conversationId = await seedConversation(db, session.sessionId, {
		title: "Budget questions",
		raw: { projectId: new ObjectId(projectId), userId },
	});
	await page.reload();
	await expect(page.getByText("Chats (1)")).toBeVisible();
	page.once("dialog", (dialog) => void dialog.accept());
	await page.getByRole("button", { name: "Remove Budget questions from project" }).click();
	await expect(page.getByText("Chats (0)")).toBeVisible();
	const kept = await db.collection("conversations").findOne({ _id: conversationId });
	expect(kept).not.toBeNull();
	expect(kept?.projectId).toBeUndefined();
});

test("the project page is one column on a phone", async ({ page, db, session }) => {
	await installUserSession(db, session.sessionId);
	await page.setViewportSize({ width: 390, height: 800 });
	await page.goto(`${E2E_APP_BASE}/projects/new`);
	await expect(page.getByLabel("Name")).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
	const box = await page.getByLabel("Name").boundingBox();
	expect(box?.width ?? 0).toBeGreaterThan(250);
	expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
});
