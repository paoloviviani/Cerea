/**
 * Loading placeholders: a region shows its skeleton or its complete content, never half, and a
 * fast load shows no skeleton at all (src/lib/components/skeleton, src/lib/utils/delayedLoading).
 *
 * The slow endpoint is delayed with `page.route`; the app is reached by client navigation from `/`
 * so the sidebar stays on screen while the page under test loads.
 */
import { test, expect, seedConversation, E2E_APP_BASE } from "./fixtures.ts";
import { randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import type { Page } from "playwright/test";

const VIEWPORTS = [
	{ name: "desktop", width: 1280, height: 800 },
	{ name: "phone", width: 390, height: 844 },
];

async function installUserSession(db: Db, sessionId: string): Promise<ObjectId> {
	const now = new Date();
	// A subject of its own per test: the server remembers a subject's user row, and every test
	// wipes and re-creates the rows.
	const sub = `e2e-owner-${randomUUID()}`;
	const { insertedId } = await db.collection("users").insertOne({
		name: "E2E Owner",
		username: sub,
		hfUserId: sub,
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

async function seedProjects(db: Db, userId: ObjectId, names: string[]) {
	const now = new Date();
	// `projects` is not wiped between tests: clear this file's leftovers first.
	await db.collection("projects").deleteMany({});
	const ids: ObjectId[] = [];
	for (const name of names) {
		const _id = new ObjectId();
		ids.push(_id);
		await db.collection("projects").insertOne({
			_id,
			userId,
			name,
			description: "",
			instructions: "",
			knowledgeBaseIds: [],
			indexPastChats: false,
			retrievalLimit: 6,
			shares: [],
			createdAt: now,
			updatedAt: now,
		} as never);
	}
	return ids;
}

/** Delays the answer to a URL pattern; the shell and its data (server load) are untouched. */
async function delay(page: Page, pattern: RegExp, ms: number) {
	await page.route(pattern, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		await route.continue();
	});
}

/** Counts every time a skeleton region is inserted, from the first paint on. */
async function watchSkeletons(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as { __skeletons: number };
		w.__skeletons = 0;
		new MutationObserver((records) => {
			for (const r of records)
				for (const n of r.addedNodes)
					if (
						n instanceof Element &&
						(n.matches("[data-testid=skeleton-region]") ||
							n.querySelector("[data-testid=skeleton-region]"))
					)
						w.__skeletons++;
		}).observe(document, { childList: true, subtree: true });
	});
}
const skeletonsSeen = (page: Page) =>
	page.evaluate(() => (window as unknown as { __skeletons: number }).__skeletons);

for (const vp of VIEWPORTS) {
	test.describe(`loading placeholders at ${vp.name}`, () => {
		test.beforeEach(async ({ page }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height });
		});

		test("the projects list is a busy skeleton, then all its rows in one step", async ({
			page,
			db,
			session,
		}) => {
			const userId = await installUserSession(db, session.sessionId);
			await seedProjects(db, userId, ["Alpha", "Bravo", "Charlie", "Delta"]);
			await delay(page, /\/api\/v2\/projects$/, 1500);
			await page.goto(`${E2E_APP_BASE}/projects`, { waitUntil: "domcontentloaded" });

			const region = page.getByTestId("skeleton-region");
			await expect(region.first()).toBeVisible();
			await expect(region.first()).toHaveAttribute("aria-busy", "true");
			await expect(region.first()).toContainText("Loading");
			// No row exists while the skeleton shows.
			await expect(page.getByRole("link", { name: /Alpha/ })).toHaveCount(0);

			// First moment any project row exists, all of them do.
			await expect(page.getByRole("link", { name: /Alpha/ }).first()).toBeVisible({
				timeout: 20_000,
			});
			for (const name of ["Bravo", "Charlie", "Delta"]) {
				await expect(page.getByRole("link", { name: new RegExp(name) }).first()).toBeVisible({
					timeout: 0,
				});
			}
			await expect(page.getByTestId("skeleton-region")).toHaveCount(0);
		});

		test("a fast response never shows a skeleton", async ({ page, db, session }) => {
			const userId = await installUserSession(db, session.sessionId);
			await seedProjects(db, userId, ["Alpha", "Bravo"]);
			await watchSkeletons(page);
			await delay(page, /\/api\/v2\/projects$/, 40);
			await page.goto(`${E2E_APP_BASE}/projects`);
			await expect(page.getByRole("link", { name: /Alpha/ }).first()).toBeVisible();
			await page.waitForTimeout(600);
			expect(await skeletonsSeen(page)).toBe(0);
		});

		test("chats list: skeleton, then rows with their project names already in place", async ({
			page,
			db,
			session,
		}) => {
			const userId = await installUserSession(db, session.sessionId);
			const [projectId] = await seedProjects(db, userId, ["Mortgage"]);
			for (const title of ["One", "Two", "Three"]) {
				await seedConversation(db, session.sessionId, {
					title,
					raw: { userId, updatedAt: new Date(), projectId },
				});
			}
			await page.goto(`${E2E_APP_BASE}/`);
			// Only the project names arrive late: the rows must wait for them.
			await delay(page, /\/api\/v2\/projects$/, 1500);
			await page.goto(`${E2E_APP_BASE}/chats`, { waitUntil: "domcontentloaded" });

			await expect(page.getByTestId("skeleton-region").first()).toBeVisible();
			await expect(page.getByTestId("chats-row")).toHaveCount(0);
			await expect(page.getByTestId("chats-row")).toHaveCount(3, { timeout: 20_000 });
			// At the first reveal the badge already carries the project's name, never "Project".
			for (const row of await page.getByTestId("chats-row").all()) {
				await expect(row).toContainText("Mortgage", { timeout: 1 });
			}
		});

		test("notifications settings: header and tabs do not move when the pane arrives", async ({
			page,
			db,
			session,
		}) => {
			await installUserSession(db, session.sessionId);
			await delay(page, /\/api\/v2\/push$/, 1500);
			await page.goto(`${E2E_APP_BASE}/settings/notifications`, { waitUntil: "domcontentloaded" });
			const heading = page.getByRole("heading", { name: "Settings", exact: true });
			await expect(page.getByTestId("skeleton-region")).toBeVisible();
			const before = await heading.boundingBox();
			await expect(page.getByTestId("skeleton-region")).toHaveCount(0, { timeout: 20_000 });
			const after = await heading.boundingBox();
			expect(after).toEqual(before);
		});

		test("the new-chat page keeps its composer and greeting still while data loads", async ({
			page,
			db,
			session,
		}) => {
			await installUserSession(db, session.sessionId);
			await delay(page, /\/api\/v2\/(?!code\/status)/, 1000);
			await page.goto(`${E2E_APP_BASE}/`);
			const composer = page.getByPlaceholder("Ask anything");
			await expect(composer).toBeVisible();
			const first = await composer.boundingBox();
			await page.waitForTimeout(1800);
			expect(await composer.boundingBox()).toEqual(first);
			const title = page.getByTestId("intro-title");
			await expect(title).toHaveCSS("opacity", "1");
		});
	});
}
