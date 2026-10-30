/**
 * Scheduled chats, hermetic: from a conversation's menu to its answer in the same chat.
 * The person opens "Schedule…" on a conversation, the editor comes up on "Continue this
 * chat", "Run now" posts the prompt with the run header and a server-side turn answers
 * (the mock upstream), and the answer is in the chat the schedule was made from. What the
 * model was offered is read off the request the mock saw: no sandbox, no questions.
 *
 * The gateway's key endpoints are not part of this stack (no gateway preset: the app talks
 * to a plain upstream), so a run here needs no key; the key's lifecycle against a mocked
 * gateway is in `src/routes/api/v2/code/__tests__/chat-schedules.spec.ts`.
 */
import { randomUUID } from "node:crypto";
import { test, expect, E2E_APP_BASE } from "./fixtures";
import { seedUser } from "./machineHarness";

test("schedule a chat from its menu, run it now, and read the answer in the same chat", async ({
	page,
	db,
	session,
	api,
	mockOpenAI,
}) => {
	await seedUser(db, session.sessionId, `e2e-${randomUUID()}`);
	await mockOpenAI.setDefaultScenario({
		content: ["The", " week", " in", " brief."],
		finishReason: "stop",
	});

	// A conversation of the person's own, with one exchange in it.
	const { conversationId, rootMessageId } = await api.createConversation();
	await api.sendMessage({ conversationId, parentId: rootMessageId, content: "hello there" });

	// The sidebar row's menu offers "Schedule…" and opens the editor on this chat.
	await page.goto(`${E2E_APP_BASE}/conversation/${conversationId}`);
	const row = page.locator(`a[href$="/conversation/${conversationId}"]`).locator("xpath=..");
	await row.hover();
	await row.getByRole("button", { name: "Chat actions" }).click();
	await page.getByRole("menuitem", { name: "Schedule…" }).click();

	const editor = page.getByTestId("schedule-editor");
	await expect(editor).toBeVisible();
	await expect(page).toHaveURL(/\/schedules\?new=1&conversation=/);
	await expect(editor.getByTestId("mode-continue")).toBeChecked();
	await expect(editor.getByLabel("Chat", { exact: true })).toHaveValue(conversationId);
	// A chat schedule has no machine to pick, and says what an unattended run cannot do.
	await expect(editor.getByLabel("1. Machine")).toHaveCount(0);
	await expect(editor.getByTestId("chat-unattended-hint")).toContainText("cannot run Python");

	await editor.getByLabel("Name", { exact: true }).fill("Weekly news");
	await editor.getByLabel("Prompt", { exact: true }).fill("Summarise the news on space travel.");
	await editor.getByRole("button", { name: "Create schedule" }).click();

	// The list names the chat it posts into.
	const schedule = page.getByTestId("schedule-row").filter({ hasText: "Weekly news" });
	await expect(schedule).toBeVisible();
	await expect(schedule.getByTestId("schedule-kind")).toHaveText("Chat");
	await expect(schedule.getByTestId("schedule-target")).toContainText("Chat ›");

	await mockOpenAI.reset();
	await mockOpenAI.setDefaultScenario({
		content: ["Scheduled", " answer", " delivered."],
		finishReason: "stop",
	});
	await schedule.getByRole("button", { name: "Run now" }).click();
	await expect(schedule.getByTestId("run-notice")).toContainText("Sent", { timeout: 30_000 });

	// The turn was an ordinary one with the header and the prompt, and nobody to ask.
	const requests = (await mockOpenAI.requests()).filter(
		(r) => r.path === "/v1/chat/completions" && r.conversationId === conversationId
	);
	const turn = requests.find((r) => JSON.stringify(r.body).includes("Scheduled run of"));
	expect(turn).toBeDefined();
	const sent = JSON.stringify(turn?.body);
	expect(sent).toContain("Summarise the news on space travel.");
	expect(sent).toContain("Python cannot be run in this scheduled run");
	const toolNames = ((turn?.body.tools ?? []) as { function?: { name?: string } }[]).map(
		(t) => t.function?.name
	);
	expect(toolNames).not.toContain("execute_code");
	expect(toolNames).not.toContain("ask_user_question");
	expect(toolNames).not.toContain("schedule");

	// The chat reads unread in the sidebar until it is opened.
	await page.goto(`${E2E_APP_BASE}/schedules`);
	await expect(page.getByTestId("unread-dot")).toBeVisible();

	// The history links to the chat, and the answer is there, after the first exchange.
	const listed = page.getByTestId("schedule-row").filter({ hasText: "Weekly news" });
	await listed.getByRole("link", { name: "History" }).click();
	const history = page.getByTestId("run-row");
	await expect(history).toHaveCount(1);
	await history
		.first()
		.getByRole("link", { name: /Open chat/ })
		.click();
	await expect(page).toHaveURL(new RegExp(`/conversation/${conversationId}`));
	const messages = page.locator('[data-message-role="user"]');
	await expect(messages.last()).toContainText("Summarise the news on space travel.");
	await expect(messages.last()).toContainText("[Scheduled run of");
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"Scheduled answer delivered.",
		{ timeout: 30_000 }
	);
	await expect(page.getByTestId("unread-dot")).toHaveCount(0);

	// Deleting the schedule removes it; the chat and its answer stay.
	await page.goto(`${E2E_APP_BASE}/schedules`);
	const again = page.getByTestId("schedule-row").filter({ hasText: "Weekly news" });
	await again.getByRole("button", { name: "Delete" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete schedule" }).click();
	await expect(page.getByTestId("schedule-row")).toHaveCount(0);
	expect(await db.collection("schedules").countDocuments({})).toBe(0);
	expect(
		await db.collection("conversations").countDocuments({ _id: { $exists: true } })
	).toBeGreaterThan(0);
});
