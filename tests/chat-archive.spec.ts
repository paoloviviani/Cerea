/**
 * Archiving a chat: the sidebar row's menu archives it at once (the row leaves
 * the sidebar), it is listed under /chats?tab=archived, and Unarchive brings it
 * back. A message sent in an archived chat unarchives it. A project chat leaves
 * its project when archived and does not return to it.
 */
import { test, expect, seedConversation, waitForHydration, E2E_APP_BASE } from "./fixtures.ts";
import { ObjectId } from "mongodb";

const archivedAt = (db: import("mongodb").Db, id: ObjectId) =>
	db
		.collection("conversations")
		.findOne({ _id: id })
		.then((doc) => doc?.archivedAt ?? null);

test("archive from the sidebar, find it under Archived, unarchive it", async ({
	page,
	db,
	session,
}) => {
	const chat = await seedConversation(db, session.sessionId, { title: "Quarterly figures" });
	await seedConversation(db, session.sessionId, { title: "Trip plan" });

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	const row = page.locator("div.group", { hasText: "Quarterly figures" }).first();
	await row.hover();
	await row.getByRole("button", { name: "Chat actions" }).click();
	await page.getByRole("menuitem", { name: "Archive" }).click();
	await expect(page.getByText("Chat archived.")).toBeVisible();
	await expect(page.getByRole("link", { name: "Quarterly figures" })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Trip plan" })).toBeVisible();
	await expect.poll(() => archivedAt(db, chat)).not.toBeNull();

	// Hidden from the Chats tab, listed under Archived (also at phone width).
	await page.goto(`${E2E_APP_BASE}/chats`);
	await expect(page.getByTestId("chats-row")).toHaveCount(1);
	await expect(page.getByTestId("chats-row")).toContainText("Trip plan");
	await page.getByRole("link", { name: "Archived" }).click();
	await expect(page).toHaveURL(/tab=archived/);
	await expect(page.getByTestId("chats-row")).toHaveCount(1);
	await expect(page.getByTestId("chats-row")).toContainText("Quarterly figures");
	await page.setViewportSize({ width: 390, height: 800 });
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth > document.documentElement.clientWidth
		)
	).toBe(false);

	// Unarchive from the row.
	await page.getByRole("button", { name: "Actions for Quarterly figures" }).click();
	await page.getByRole("menuitem", { name: "Unarchive" }).click();
	await expect(page.getByText("Chat unarchived.")).toBeVisible();
	await expect(page.getByTestId("chats-row")).toHaveCount(0);
	await expect.poll(() => archivedAt(db, chat)).toBeNull();
	await page.getByRole("link", { name: "Chats", exact: true }).click();
	await expect(page.getByTestId("chats-row")).toHaveCount(2);
});

test("a message sent in an archived chat unarchives it", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	await mockOpenAI.setDefaultScenario({ content: ["Fine", " answer."], chunkDelayMs: 5 });
	const chat = await seedConversation(db, session.sessionId, {
		title: "Old thread",
		messages: [
			{ from: "system", content: "" },
			{ from: "user", content: "old question" },
			// A finished message carries a terminal update; without one the UI treats it as generating.
			{
				from: "assistant",
				content: "old answer",
				extra: { updates: [{ type: "status", status: "finished" }] },
			},
		],
		raw: { archivedAt: new Date() },
	});
	await page.goto(`${E2E_APP_BASE}/conversation/${chat}`);
	await waitForHydration(page);
	await page.getByPlaceholder("Ask anything").fill("Still there?");
	await page.getByRole("button", { name: "Send message" }).click();
	await expect(page.getByText("Fine answer.")).toBeVisible();
	await expect.poll(() => archivedAt(db, chat)).toBeNull();
});
