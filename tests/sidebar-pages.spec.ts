/**
 * The sidebar's two top-level branches are pages as well as folders: the
 * **label** of Projects opens `/projects`, the label of Chats opens `/chats`
 * (a searchable list of every chat), and only the **chevron** expands or
 * collapses a branch.
 *
 * The user is a real row with a session, as `project-page.spec` does: chats
 * and projects belong to an account. Conversations are seeded straight into
 * Mongo, with titles that need the search's case and accent folding.
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

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function seedChats(db: Db, sessionId: string, userId: ObjectId) {
	const now = new Date();
	const projectId = new ObjectId();
	await db.collection("projects").insertOne({
		_id: projectId,
		userId,
		name: "Mortgage",
		description: "",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: false,
		retrievalLimit: 6,
		shares: [],
		createdAt: now,
		updatedAt: now,
	} as never);
	const chat = (title: string, updatedAt: Date, extra: Record<string, unknown> = {}) =>
		seedConversation(db, sessionId, { title, raw: { userId, updatedAt, ...extra } });
	const cafe = await chat("Café Müller menu ideas", minutesAgo(5));
	await chat("Trip to Zürich", minutesAgo(60));
	await chat("Refinance the mortgage", minutesAgo(180), { projectId });
	await chat("Sourdough starter notes", minutesAgo(60 * 24 * 3));
	return { cafe, projectId };
}

test.describe("the sidebar's Projects and Chats headers", () => {
	test("the Chats label opens a searchable list; typing filters it; a result opens the chat", async ({
		page,
		db,
		session,
	}) => {
		const userId = await installUserSession(db, session.sessionId);
		const { cafe } = await seedChats(db, session.sessionId, userId);

		await page.goto(`${E2E_APP_BASE}/`);
		await page.locator("nav").getByRole("link", { name: "Chats", exact: true }).click();
		await page.waitForURL(`**${E2E_APP_BASE}/chats`);

		// The search box has the focus the moment the page opens.
		const search = page.getByRole("searchbox", { name: "Search chats by title" });
		await expect(search).toBeFocused();

		// Every chat, newest first, the project chat marked with its project.
		const rows = page.getByTestId("chats-row");
		await expect(rows).toHaveCount(4);
		await expect(rows.first()).toContainText("Café Müller menu ideas");
		await expect(rows.first()).toContainText("5 minutes ago");
		await expect(rows.nth(2)).toContainText("Refinance the mortgage");
		await expect(rows.nth(2)).toContainText("Mortgage");
		await expect(rows.nth(0)).not.toContainText("Mortgage");

		// Case and accents do not matter, and the filter is the server's.
		const filtered = page.waitForResponse(
			(response) =>
				response.url().includes("/api/v2/conversations?") && response.url().includes("q=")
		);
		await search.pressSequentially("CAFE MULLER");
		await filtered;
		await expect(rows).toHaveCount(1);
		await expect(rows.first()).toContainText("Café Müller menu ideas");

		await rows.first().click();
		await page.waitForURL(`**${E2E_APP_BASE}/conversation/${cafe.toString()}`);
	});

	test("a search with no match says so, and clearing it brings the list back", async ({
		page,
		db,
		session,
	}) => {
		const userId = await installUserSession(db, session.sessionId);
		await seedChats(db, session.sessionId, userId);

		await page.goto(`${E2E_APP_BASE}/chats`);
		await expect(page.getByTestId("chats-row")).toHaveCount(4);

		await page.getByRole("searchbox").fill("(c++ [nothing]");
		await expect(page.getByTestId("chats-no-results")).toContainText("No chats match");
		await expect(page.getByTestId("chats-row")).toHaveCount(0);

		// The empty state's own button and the box's ✕ do the same thing.
		await page.getByRole("button", { name: "Show all chats" }).click();
		await expect(page.getByTestId("chats-row")).toHaveCount(4);
		await expect(page.getByRole("searchbox")).toBeFocused();

		await page.getByRole("searchbox").fill("sourdough");
		await expect(page.getByTestId("chats-row")).toHaveCount(1);
		await page.getByRole("button", { name: "Clear search" }).click();
		await expect(page.getByTestId("chats-row")).toHaveCount(4);
		await expect(page.getByRole("searchbox")).toHaveValue("");
	});

	test("with no chats at all, the page says so and offers a new one", async ({
		page,
		db,
		session,
	}) => {
		await installUserSession(db, session.sessionId);

		await page.goto(`${E2E_APP_BASE}/chats`);
		await expect(page.getByTestId("chats-empty")).toContainText("No chats yet");
		await expect(
			page.getByTestId("chats-empty").getByRole("link", { name: /Start a chat/ })
		).toBeVisible();
	});

	test("the Projects label opens the list of projects", async ({ page, db, session }) => {
		const userId = await installUserSession(db, session.sessionId);
		await seedChats(db, session.sessionId, userId);

		await page.goto(`${E2E_APP_BASE}/`);
		await page.locator("nav").getByRole("link", { name: "Projects", exact: true }).click();
		await page.waitForURL(`**${E2E_APP_BASE}/projects`);
		await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
		await expect(page.getByRole("link", { name: /Mortgage/ }).last()).toBeVisible();
	});

	test("the chevrons collapse and expand each branch without navigating", async ({
		page,
		db,
		session,
	}) => {
		const userId = await installUserSession(db, session.sessionId);
		await seedChats(db, session.sessionId, userId);

		await page.goto(`${E2E_APP_BASE}/`);
		const nav = page.locator("nav");
		const url = page.url();

		// Chats starts open, with its (loose) chats in it.
		await expect(nav.getByText("Trip to Zürich")).toBeVisible();
		await nav.getByRole("button", { name: "Collapse Chats" }).click();
		await expect(nav.getByText("Trip to Zürich")).toHaveCount(0);
		await expect(nav.getByRole("button", { name: "Expand Chats" })).toHaveAttribute(
			"aria-expanded",
			"false"
		);
		await nav.getByRole("button", { name: "Expand Chats" }).click();
		await expect(nav.getByText("Trip to Zürich")).toBeVisible();

		// Projects starts closed and loads its list only when opened.
		await expect(nav.getByText("Mortgage")).toHaveCount(0);
		await nav.getByRole("button", { name: "Expand Projects" }).click();
		await expect(nav.getByText("Mortgage")).toBeVisible();
		await nav.getByRole("button", { name: "Collapse Projects" }).click();
		await expect(nav.getByText("Mortgage")).toHaveCount(0);

		expect(page.url()).toBe(url);
	});

	test("Tab reaches each header's chevron and label as separate stops", async ({
		page,
		db,
		session,
	}) => {
		await installUserSession(db, session.sessionId);

		await page.goto(`${E2E_APP_BASE}/`);
		await page.locator("nav").getByRole("button", { name: "Expand Projects" }).focus();
		await page.keyboard.press("Tab");
		await expect(
			page.locator("nav").getByRole("link", { name: "Projects", exact: true })
		).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(page.locator("nav").getByRole("button", { name: "New project" })).toBeFocused();
	});
});
