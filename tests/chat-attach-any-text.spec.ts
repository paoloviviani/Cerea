/**
 * A text file is accepted whatever its extension: a `.excalidraw` scene (JSON)
 * is attached through the composer's picker, which no longer filters by
 * extension, and its content reaches the model under its own file name. The
 * mock model records every request, so the body is checked for what the model
 * was actually sent.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

const SCENE = JSON.stringify({
	type: "excalidraw",
	version: 2,
	elements: [{ id: "box-7f3a", type: "rectangle", x: 10, y: 20 }],
});

test("an .excalidraw attachment reaches the model with its name and content", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(150_000);
	await mockOpenAI.setDefaultScenario({
		content: ["Seen."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});

	await page.goto(`${E2E_APP_BASE}/`);
	// The picker takes any file: no `accept` filter hides a type it does not know.
	const input = page.getByLabel("Upload file");
	expect((await input.getAttribute("accept")) ?? "").toBe("");
	await input.setInputFiles({
		name: "scene.excalidraw",
		mimeType: "application/octet-stream",
		buffer: Buffer.from(SCENE),
	});
	await expect(page.getByText("scene.excalidraw")).toBeVisible();
	await page.getByPlaceholder("Ask anything").fill("what is in my drawing?");
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText("Seen.", {
		timeout: 90_000,
	});

	const sent = JSON.stringify((await mockOpenAI.requests()).at(-1)?.body.messages);
	expect(sent).toContain("scene.excalidraw");
	expect(sent).toContain("box-7f3a");
});
