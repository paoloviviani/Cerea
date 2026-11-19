/**
 * An upstream error before any output (a gateway 401 on an expired key) must
 * end as a stable failed turn: the banner stays, the page does not re-attach
 * to the stream or reload the conversation in a loop, and Retry works.
 */
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

const SEND = { name: "Send message" };
const MESSAGE = "say something";

function countRequests(page: Page) {
	const counts = { stream: 0, data: 0 };
	page.on("request", (req) => {
		const url = req.url();
		if (/\/conversation\/[a-f0-9]{24}\/stream/.test(url)) counts.stream += 1;
		else if (/\/conversation\/[a-f0-9]{24}\/__data\.json/.test(url)) counts.data += 1;
	});
	return counts;
}

test("a 401 before any output ends as a stable failed turn and Retry works", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(90_000);
	await mockOpenAI.setDefaultScenario({
		errorStatus: 401,
		errorMessage: "invalid API key",
		nonStreamContent: "Failing chat",
	});
	const counts = countRequests(page);
	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill(MESSAGE);
	await page.getByRole("button", SEND).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);

	await expect(page.getByTestId("turn-failed-retry")).toBeVisible({ timeout: 30_000 });

	// Settle, then watch: a loop would keep issuing stream / data requests.
	await page.waitForTimeout(1500);
	const settled = { ...counts };
	await page.waitForTimeout(5000);
	expect(counts.stream - settled.stream).toBeLessThanOrEqual(1);
	expect(counts.data - settled.data).toBeLessThanOrEqual(1);
	expect(counts.stream).toBeLessThanOrEqual(2);
	await expect(page.getByTestId("turn-failed-retry")).toBeVisible();

	await mockOpenAI.setDefaultScenario("plainText");
	await page.getByTestId("turn-failed-retry").click({ timeout: 5000 });
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"Hello from the mock server.",
		{ timeout: 30_000 }
	);
});

test("a 401 after partial output is also stable", async ({ page, mockOpenAI }) => {
	test.setTimeout(90_000);
	await mockOpenAI.setDefaultScenario({
		content: ["partial-", "beta"],
		chunkDelayMs: 10,
		streamError: "401 invalid API key",
		nonStreamContent: "Failing chat",
	});
	const counts = countRequests(page);
	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill(MESSAGE);
	await page.getByRole("button", SEND).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.getByTestId("turn-failed-retry")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	const settled = { ...counts };
	await page.waitForTimeout(5000);
	expect(counts.stream - settled.stream).toBeLessThanOrEqual(1);
	expect(counts.data - settled.data).toBeLessThanOrEqual(1);
	await expect(page.getByTestId("turn-failed-retry")).toBeVisible();
});

test("a 401 on a later turn, and a reload afterwards, stay stable", async ({
	page,
	mockOpenAI,
}) => {
	test.setTimeout(90_000);
	await mockOpenAI.setDefaultScenario("plainText");
	await page.goto(`${E2E_APP_BASE}/`);
	await page.getByPlaceholder("Ask anything").fill(MESSAGE);
	await page.getByRole("button", SEND).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
		"Hello from the mock server.",
		{ timeout: 30_000 }
	);

	await mockOpenAI.setDefaultScenario({
		errorStatus: 401,
		errorMessage: "invalid x-api-key",
		nonStreamContent: "Failing chat",
	});
	const counts = countRequests(page);
	await page.getByPlaceholder("Ask anything").fill("second");
	await page.getByRole("button", SEND).click();
	await expect(page.getByTestId("turn-failed-retry")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	const settled = { ...counts };
	await page.waitForTimeout(5000);
	expect(counts.stream - settled.stream).toBeLessThanOrEqual(1);
	expect(counts.data - settled.data).toBeLessThanOrEqual(1);

	await page.reload();
	await expect(page.getByTestId("turn-failed-retry")).toBeVisible({ timeout: 30_000 });
	const afterReload = { ...counts };
	await page.waitForTimeout(5000);
	expect(counts.stream - afterReload.stream).toBeLessThanOrEqual(1);
	expect(counts.data - afterReload.data).toBeLessThanOrEqual(1);
});
