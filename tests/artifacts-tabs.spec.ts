/**
 * The Artifacts tabs: the project page's and the chats page's. What the model
 * made in your own chats is listed, newest first, with the chat it came from;
 * a link opens that chat with the artifact in the side panel. A colleague's
 * chat in a shared project is not listed.
 *
 * Set ARTIFACTS_SHOTS_DIR to also write screenshots of both tabs (1440 and 390).
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

const page_ = (body: string) =>
	`Here is the page.\n<artifact identifier="landing" type="html" title="Landing page">${body}</artifact>`;

async function addFile(
	db: Db,
	conversationId: ObjectId,
	name: string,
	version: number,
	ago: number
) {
	await db.collection("codeExecutionOutputs").insertOne({
		_id: new ObjectId(),
		conversationId,
		sha256: `${name}${version}`.padEnd(64, "0").slice(0, 64),
		name,
		mime: "application/octet-stream",
		size: 4096 * version,
		gridFsId: new ObjectId(),
		version,
		tool: version === 1 ? "doc_create" : "doc_edit",
		createdAt: new Date(Date.now() - ago),
	});
}

test("the Artifacts tabs list your own chats' artifacts and open them in the side panel", async ({
	page,
	db,
	session,
}) => {
	const userId = await installUserSession(db, session.sessionId);
	const colleague = new ObjectId();
	const projectId = new ObjectId();
	const now = new Date();
	await db.collection("projects").insertOne({
		_id: projectId,
		userId,
		name: "E2E project",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: false,
		retrievalLimit: 6,
		shares: [],
		createdAt: now,
		updatedAt: now,
	});
	const inProject = await seedConversation(db, session.sessionId, {
		title: "Landing page work",
		messages: [
			{ from: "system", content: "" },
			{ from: "user", content: "make a page" },
			{
				from: "assistant",
				content: page_("<h1>Hello</h1>"),
				extra: { createdAt: new Date(Date.now() - 5 * 3600_000) },
			},
		],
		raw: { projectId, userId },
	});
	await addFile(db, inProject, "budget.docx", 1, 3 * 3600_000);
	await addFile(db, inProject, "budget.docx", 2, 3600_000);
	const others = await seedConversation(db, session.sessionId, {
		title: "Colleague salary talk",
		raw: { projectId, userId: colleague, sessionId: undefined },
	});
	await addFile(db, others, "salaries.xlsx", 1, 1000);
	const free = await seedConversation(db, session.sessionId, {
		title: "Free chat",
		raw: { userId },
	});
	await addFile(db, free, "trip.pdf", 1, 2 * 3600_000);

	const shots = process.env.ARTIFACTS_SHOTS_DIR;
	const shoot = async (name: string) => {
		if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
	};

	// The project's tab.
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${E2E_APP_BASE}/projects/${projectId}?tab=artifacts`);
	const rows = page.getByTestId("artifacts-row");
	await expect(rows).toHaveCount(2);
	await expect(rows.first()).toContainText("budget.docx");
	await expect(rows.first()).toContainText("v2");
	await expect(rows.first()).toContainText("2 versions");
	await expect(rows.first()).toContainText("From Landing page work");
	await expect(rows.nth(1)).toContainText("Landing page");
	await expect(page.locator("body")).not.toContainText("salaries.xlsx");
	await expect(page.locator("body")).not.toContainText("Colleague salary talk");
	await expect(page.locator("body")).not.toContainText("trip.pdf");
	await shoot("project-1440");
	await page.setViewportSize({ width: 390, height: 800 });
	await shoot("project-390");
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth
	);
	expect(overflow).toBe(false);

	// The name filter.
	await page.getByTestId("artifacts-search").fill("budget");
	await expect(rows).toHaveCount(1);
	await page.getByTestId("artifacts-search").fill("");
	await expect(rows).toHaveCount(2);

	// Opening an artifact: the chat, with the artifact in the side panel.
	await page.getByRole("link", { name: "Open Landing page in its chat" }).click();
	await page.waitForURL(new RegExp(`/conversation/${inProject}`));
	await expect(page.getByText("Landing page").first()).toBeVisible();
	await expect(page.locator("iframe").first()).toBeVisible();

	// The chats page's tab: only the chat that is in no project.
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${E2E_APP_BASE}/chats?tab=artifacts`);
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText("trip.pdf");
	await expect(page.locator("body")).not.toContainText("budget.docx");
	await shoot("chats-1440");
	await page.setViewportSize({ width: 390, height: 800 });
	await shoot("chats-390");
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth > document.documentElement.clientWidth
		)
	).toBe(false);
});
