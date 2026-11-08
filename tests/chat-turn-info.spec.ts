/**
 * The info dot under an answer and what it opens: the numbers of the turn and
 * what the gateway's redaction hid. The mock upstream sends `pystino_redaction`
 * on the closing usage chunk when the request asks for the summary, and its
 * `values` only when the request also asks for them.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";
import type { Db } from "mongodb";
import type { Page } from "playwright/test";

const REDACTION = {
	applied: true,
	request_id: "req_e2e",
	blocked: false,
	entities: [
		{
			type: "PERSON",
			count: 2,
			mode: "anonymise_restore",
			rule: { id: "r1", name: "Cloud providers", owner: "admin" },
			sources: ["message"],
		},
		{
			type: "IT_FISCAL_CODE",
			count: 1,
			mode: "redact",
			rule: { id: "r2", owner: "user" },
			sources: ["tool_result"],
		},
	],
	values: [{ type: "PERSON", original: "Mario Rossi", placeholder: "<PERSON_1>" }],
};

async function send(page: Page, text: string) {
	await page.getByPlaceholder("Ask anything").fill(text);
	await page.getByRole("button", { name: "Send message" }).click();
}

async function showValues(db: Db, session: { sessionId: string }, on: boolean) {
	await db
		.collection("settings")
		.updateOne({ sessionId: session.sessionId }, { $set: { showRedactionValues: on } });
}

const chatRequests = async (mockOpenAI: {
	requests(): Promise<
		Array<{ path: string; body: Record<string, unknown>; headers?: Record<string, string> }>
	>;
}) =>
	(await mockOpenAI.requests()).filter(
		(r) => r.path === "/v1/chat/completions" && r.body.stream === true
	);

test("a plain answer has a grey dot with the turn's numbers", async ({ page, mockOpenAI }) => {
	await mockOpenAI.setDefaultScenario({
		content: ["Plain", " answer."],
		chunkDelayMs: 5,
		usage: { prompt_tokens: 120, completion_tokens: 8 },
		cost: "0.0003 USD",
	});
	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "hello");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.getByText("Plain answer.")).toBeVisible({ timeout: 30_000 });

	const dot = page.getByTestId("turn-info-dot");
	await expect(dot).toHaveAttribute("data-state", "neutral", { timeout: 15_000 });
	await dot.click();
	const panel = page.getByTestId("turn-info-panel");
	await expect(panel).toContainText("120");
	await expect(panel).toContainText("0.0003 USD");
	await expect(page.getByTestId("turn-info-redaction")).toHaveCount(0);
});

test("@smoke redaction turns the dot yellow, shows values only when the setting is on, and survives a reload", async ({
	page,
	db,
	session,
	mockOpenAI,
}) => {
	await mockOpenAI.setDefaultScenario({
		content: ["Dear", " Mario."],
		chunkDelayMs: 5,
		usage: { prompt_tokens: 50, completion_tokens: 4 },
		redaction: REDACTION,
	});

	// Setting off (the default): the summary is asked for, the values are not.
	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "write to Mario Rossi");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.getByText("Dear Mario.")).toBeVisible({ timeout: 30_000 });
	const dot = page.getByTestId("turn-info-dot");
	await expect(dot).toHaveAttribute("data-state", "applied", { timeout: 15_000 });
	await expect(dot).toHaveAttribute("aria-label", /values were hidden/);
	await dot.click();
	await expect(page.getByTestId("turn-info-summary")).toContainText(
		"2 names (admin rule “Cloud providers”)"
	);
	await expect(page.getByTestId("turn-info-summary")).toContainText("1 fiscal code (your rule)");
	await expect(page.getByTestId("turn-info-values")).toHaveCount(0);
	const first = (await chatRequests(mockOpenAI)).at(-1);
	expect(first?.headers?.["x-pystino-redaction-summary"]).toBe("1");
	expect(first?.headers?.["x-pystino-redaction-values"]).toBeUndefined();

	// Setting on: the values are asked for, shown, and kept with the chat.
	await page.keyboard.press("Escape");
	await showValues(db, session, true);
	await send(page, "and again");
	await expect(page.getByText("Dear Mario.")).toHaveCount(2, { timeout: 30_000 });
	await expect
		.poll(
			async () => (await chatRequests(mockOpenAI)).at(-1)?.headers?.["x-pystino-redaction-values"]
		)
		.toBe("1");

	await page.reload();
	const dots = page.getByTestId("turn-info-dot");
	await expect(dots).toHaveCount(2, { timeout: 30_000 });
	await expect(dots.nth(0)).toHaveAttribute("data-state", "applied");
	await dots.nth(1).click();
	await expect(page.getByTestId("turn-info-values")).toContainText("Mario Rossi → name");

	// The first answer was made with the setting off: it keeps no values.
	await page.keyboard.press("Escape");
	await dots.nth(0).click();
	await expect(page.getByTestId("turn-info-values")).toHaveCount(0);
});

test("a refused request turns the dot red", async ({ page, mockOpenAI }) => {
	await mockOpenAI.setDefaultScenario({
		content: ["Sorry."],
		chunkDelayMs: 5,
		redaction: {
			...REDACTION,
			blocked: true,
			entities: [{ ...REDACTION.entities[0], mode: "block" }],
		},
	});
	await page.goto(`${E2E_APP_BASE}/`);
	await send(page, "hello");
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
	await expect(page.getByText("Sorry.")).toBeVisible({ timeout: 30_000 });
	const dot = page.getByTestId("turn-info-dot");
	await expect(dot).toHaveAttribute("data-state", "blocked", { timeout: 15_000 });
	await expect(dot).toHaveAttribute("aria-label", /refused/);
});
