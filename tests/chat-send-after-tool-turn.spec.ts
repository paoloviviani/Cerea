/**
 * C156: the tab proposes the ids of the messages a send creates and the server stores exactly
 * those, so a send made the instant a tool turn ends names a parent the server holds: no 409,
 * no re-sync toast, no second user message.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { Page } from "playwright/test";

const TOOL_MODEL = "test-org/artifact-tool";

async function send(page: Page, text: string) {
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
}

test("a send right after a tool turn keeps one id per message and sends once", async ({
	page,
	mockOpenAI,
	db,
	session,
}) => {
	await db
		.collection("settings")
		.updateOne({ sessionId: session.sessionId }, { $set: { activeModel: TOOL_MODEL } });
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_create",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "quick",
					type: "markdown",
					title: "Quick",
					content: "# Quick\n\nOne.\n",
				}),
			},
		],
		content: ["Built", "."],
		chunkDelayMs: 5,
	});

	// The ids each send proposed, read off its request.
	const proposed: { userMessageId?: string; assistantMessageId?: string }[] = [];
	page.on("request", (request) => {
		if (request.method() !== "POST" || !/\/conversation\/[a-f0-9]{24}$/.test(request.url())) return;
		const body = request.postData() ?? "";
		const match = body.match(/name="data"\r\n\r\n([^\r]*)/);
		if (match) proposed.push(JSON.parse(match[1]));
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "first");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	// The reply is done as soon as the composer takes a send again.
	const sendButton = page.getByRole("button", { name: "Send message" });
	await expect(page.getByText("Built.", { exact: false }).first()).toBeVisible({
		timeout: 30_000,
	});
	// No wait for the post-turn refresh: send at once.
	await mockOpenAI.setDefaultScenario({ content: ["Second", " reply", "."], chunkDelayMs: 5 });
	await page.getByPlaceholder("Ask anything").fill("second");
	await sendButton.click();
	await expect(page.getByText("Second reply.", { exact: false }).first()).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText("Syncing and sending again")).toHaveCount(0);

	const conversation = await db
		.collection("conversations")
		.findOne({ sessionId: session.sessionId });
	// The system root is not a send's message.
	const messages = (
		(conversation?.messages ?? []) as {
			id: string;
			from: string;
			content: string;
			ancestors: string[];
		}[]
	).filter((message) => message.from !== "system");
	expect(messages.map((message) => message.from)).toEqual([
		"user",
		"assistant",
		"user",
		"assistant",
	]);
	expect(new Set(messages.map((message) => message.id)).size).toBe(4);
	expect(messages[2].content).toBe("second");
	// The stored ids are the proposed ones: nothing for the tab to swap after a turn. (The
	// first message of a new chat is created by another route, so only the second send counts.)
	const second = proposed.at(-1);
	expect(second?.userMessageId).toBe(messages[2].id);
	expect(second?.assistantMessageId).toBe(messages[3].id);
	expect(messages[3].ancestors).toEqual(
		expect.arrayContaining([messages[0].id, messages[1].id, messages[2].id])
	);
});
