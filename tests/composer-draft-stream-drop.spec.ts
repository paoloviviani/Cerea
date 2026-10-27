/**
 * A send the server accepted must not put its text back in the composer when
 * the reply stream is cut mid-way (a dropped connection, a phone going to
 * sleep). The text lives in the thread; restoring it left the sent message
 * sitting in the box, and in storage, after a successful send.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

const SEND = { name: "Send message" };

test("a reply stream cut mid-way leaves the composer empty, not holding the sent text", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(60_000);
	await mockOpenAI.setDefaultScenario({
		content: Array.from({ length: 40 }, (_, i) => `word${i} `),
		chunkDelayMs: 300,
		finishReason: "stop" as const,
	});
	// The server gets the whole request; the browser loses the stream after its
	// first chunk, as a network drop would.
	await page.addInitScript(() => {
		const realFetch = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const res = await realFetch(input, init);
			const url = new URL(
				typeof input === "string" ? input : (input as Request).url,
				location.href
			);
			if (
				init?.method === "POST" &&
				/\/conversation\/[a-f0-9]{24}$/.test(url.pathname) &&
				res.body
			) {
				const reader = res.body.getReader();
				let sentFirst = false;
				const body = new ReadableStream({
					async pull(controller) {
						if (sentFirst) {
							reader.cancel().catch(() => {});
							controller.error(new TypeError("network error"));
							return;
						}
						const chunk = await reader.read();
						if (chunk.done) {
							controller.close();
							return;
						}
						sentFirst = true;
						controller.enqueue(chunk.value);
					},
				});
				return new Response(body, { status: res.status, headers: res.headers });
			}
			return res;
		};
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill("this was sent");
	await page.getByRole("button", SEND).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	const conversationId = page.url().split("/").pop() ?? "";

	await expect(page.getByLabel("Conversation messages").getByText("this was sent")).toBeVisible();
	// Let the cut stream end and the composer settle, then check it twice over:
	// the box and what a reload would restore.
	await page.waitForTimeout(2_000);
	await expect(page.getByPlaceholder("Ask anything")).toHaveValue("");
	await page.waitForTimeout(800);
	const stored = await page.evaluate(
		(id) => localStorage.getItem(`cerea:composer-draft:chat:${id}`),
		conversationId
	);
	expect(stored).toBeNull();
});

test("a send the server rejects puts its text back in the composer", async ({ page }) => {
	await page.route(/\/conversation\/[a-f0-9]{24}$/, async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		await route.fulfill({
			status: 429,
			contentType: "application/json",
			body: JSON.stringify({ message: "Too many requests" }),
		});
	});

	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill("never accepted");
	await page.getByRole("button", SEND).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.getByPlaceholder("Ask anything")).toHaveValue("never accepted");
});
