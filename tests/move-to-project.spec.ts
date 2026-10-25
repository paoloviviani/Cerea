/**
 * Moving a chat into, between and out of projects, from the places a person
 * can: the sidebar row's menu and the picker it opens, a drag in the sidebar,
 * the Chats list, and the project page (which on a phone must also name the
 * project in the top bar and keep chat titles readable).
 *
 * Set `MOVE_SHOTS=/some/dir` to also write screenshots there (desktop and
 * phone, light and dark); without it the spec only asserts.
 */
import { test, expect, seedConversation, waitForHydration, E2E_APP_BASE } from "./fixtures.ts";
import { ObjectId, type Db } from "mongodb";
import type { Locator, Page } from "playwright/test";

/** A locator's box; fails the test if the element is not laid out. */
async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("element has no bounding box");
	return box;
}

const SHOTS = process.env.MOVE_SHOTS;
async function shot(page: Page, name: string) {
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

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

async function seedProject(db: Db, userId: ObjectId, name: string): Promise<ObjectId> {
	const now = new Date();
	const _id = new ObjectId();
	await db.collection("projects").insertOne({
		_id,
		userId,
		name,
		instructions: "",
		knowledgeBaseIds: [],
		// Off: what is under test is the move, not the indexing pipeline.
		indexPastChats: false,
		retrievalLimit: 6,
		shares: [],
		createdAt: now,
		updatedAt: now,
	});
	return _id;
}

const projectOf = async (db: Db, id: ObjectId) =>
	(await db.collection("conversations").findOne({ _id: id }))?.projectId?.toString();

for (const scheme of ["light", "dark"] as const) {
	test(`desktop ${scheme}: menu, picker, drag, and the toast`, async ({ page, db, session }) => {
		const userId = await installUserSession(db, session.sessionId);
		await page.emulateMedia({ colorScheme: scheme });
		await page.setViewportSize({ width: 1440, height: 900 });
		const budget = await seedProject(db, userId, "Budget 2027");
		const report = await seedProject(db, userId, "Annual report");
		const loose = await seedConversation(db, session.sessionId, {
			title: "Quarterly figures",
			raw: { userId },
		});
		const second = await seedConversation(db, session.sessionId, {
			title: "Draft the cover letter",
			raw: { userId },
		});
		await seedConversation(db, session.sessionId, {
			title: "Travel costs",
			raw: { userId, projectId: budget },
		});

		await page.goto(`${E2E_APP_BASE}/`);
		// The sidebar is server-rendered: an "Expand Projects" click before
		// hydration reaches no handler and is lost (the folder never opens).
		await waitForHydration(page);
		await page.getByRole("button", { name: "Expand Projects" }).click();
		await expect(page.getByText("Budget 2027")).toBeVisible();

		// The row menu and the picker.
		const row = page.locator("div.group", { hasText: "Quarterly figures" }).first();
		await row.hover();
		await row.getByRole("button", { name: "Chat actions" }).click();
		await shot(page, `${scheme}-1440-menu`);
		await page.getByRole("menuitem", { name: "Move to project…" }).click();
		await expect(page.getByRole("heading", { name: "Move to project" })).toBeVisible();
		const picker = page.getByLabel("Move to project");
		await expect(picker.getByRole("button", { name: "Annual report" })).toBeVisible();
		await shot(page, `${scheme}-1440-picker`);
		await picker.getByRole("button", { name: "Annual report" }).click();
		await expect(page.getByText("Moved to Annual report")).toBeVisible();
		await shot(page, `${scheme}-1440-toast`);
		await expect.poll(() => projectOf(db, loose)).toBe(report.toString());

		// A drag onto the other project, shown part-way through.
		const dragged = page.getByRole("link", { name: "Draft the cover letter" });
		const target = page.getByRole("button", { name: "Budget 2027", exact: true });
		await dragged.hover();
		await page.mouse.down();
		const box = await boxOf(target);
		await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 8 });
		await page.mouse.move(box.x + 44, box.y + box.height / 2 + 1);
		await expect(page.locator(".ring-accent")).toBeVisible();
		await expect(page.getByText("Drop a file to add it to the chat")).toHaveCount(0);
		await shot(page, `${scheme}-1440-drag`);
		await page.mouse.up();
		await expect.poll(() => projectOf(db, second)).toBe(budget.toString());

		// And a project chat dragged out to the loose list.
		// The drop opened the folder, so the chat is already listed in it.
		const inside = page.getByRole("link", { name: "Draft the cover letter" });
		await expect(inside).toBeVisible();
		await inside.hover();
		await page.mouse.down();
		const chats = await boxOf(page.getByRole("link", { name: "Chats" }).first());
		await page.mouse.move(chats.x + 30, chats.y + chats.height / 2, { steps: 8 });
		await page.mouse.up();
		await expect.poll(() => projectOf(db, second)).toBeUndefined();
	});
}

for (const scheme of ["light", "dark"] as const) {
	test(`phone ${scheme}: the project page names the project and keeps titles readable`, async ({
		page,
		db,
		session,
	}) => {
		const userId = await installUserSession(db, session.sessionId);
		await page.emulateMedia({ colorScheme: scheme });
		await page.setViewportSize({ width: 390, height: 800 });
		const project = await seedProject(db, userId, "Budget 2027");
		await seedProject(db, userId, "Annual report");
		await seedConversation(db, session.sessionId, {
			title: "Travel costs for the Brussels meeting",
			raw: { userId, projectId: project },
		});
		await seedConversation(db, session.sessionId, {
			title: "Eligible staff costs",
			raw: { userId, projectId: project },
		});
		await page.goto(`${E2E_APP_BASE}/projects/${project}`);
		await expect(page.getByText("Chats (2)")).toBeVisible();
		await expect(page.locator("nav").first()).toContainText("Budget 2027");
		await expect(page.locator("nav").first()).not.toContainText("New chat");
		// A title shows more than a few letters.
		const title = page.getByText("Travel costs for the Brussels meeting");
		expect((await boxOf(title)).width).toBeGreaterThan(150);
		await shot(page, `${scheme}-390-project-page`);

		await page.getByRole("button", { name: "Actions for Eligible staff costs" }).click();
		await shot(page, `${scheme}-390-project-menu`);
		await page.getByRole("menuitem", { name: "Move to project…" }).click();
		await shot(page, `${scheme}-390-picker`);
		await page.getByLabel("Move to project").getByRole("button", { name: "Annual report" }).click();
		await expect(page.getByText("Chats (1)")).toBeVisible();
		await expect(page.getByText("Moved to Annual report").first()).toBeVisible();
	});
}

test("the Chats list: move a chat in from its menu, and take it out", async ({
	page,
	db,
	session,
}) => {
	const userId = await installUserSession(db, session.sessionId);
	const project = await seedProject(db, userId, "Budget 2027");
	const chat = await seedConversation(db, session.sessionId, {
		title: "Quarterly figures",
		raw: { userId },
	});
	await page.goto(`${E2E_APP_BASE}/chats`);
	await page.getByRole("button", { name: "Actions for Quarterly figures" }).click();
	await page.getByRole("menuitem", { name: "Move to project…" }).click();
	await page.getByLabel("Move to project").getByRole("button", { name: "Budget 2027" }).click();
	await expect.poll(() => projectOf(db, chat)).toBe(project.toString());
	await page.getByRole("button", { name: "Actions for Quarterly figures" }).click();
	await page.getByRole("menuitem", { name: "Remove from project" }).click();
	await expect.poll(() => projectOf(db, chat)).toBeUndefined();
});
