/**
 * The fork handoff against a real machine (the parity chain: the real
 * `galopin` supervising a real `opencode serve`, only the LLM and the IdP
 * mocked): a finished multi-turn session offers "Fork from here" on every
 * finished assistant message — not only the one a turn's ending happened to
 * land on — and forking from an EARLIER one opens the prefilled dialog,
 * creates the "Fork: …" session, and its first prompt carries the chat
 * history cut at that message.
 */
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE } from "./fixtures";
import { opencodeAvailable, seedUser, startMachine, type Machine } from "./machineHarness";
import type { Db } from "mongodb";

test.describe("owned machine agent: fork handoff", () => {
	test.skip(!opencodeAvailable(), "needs the opencode binary on PATH");
	test.describe.configure({ mode: "serial", timeout: 180_000 });

	let machine: Machine | null = null;

	// eslint-disable-next-line no-empty-pattern
	test.afterEach(async ({}, testInfo) => {
		if (machine && testInfo.status !== testInfo.expectedStatus) {
			await testInfo.attach("galopin.log", {
				body: machine.logs(),
				contentType: "text/plain",
			});
			writeFileSync(testInfo.outputPath("galopin.log"), machine.logs());
		}
		await machine?.stop();
		machine = null;
	});

	async function openSession(page: Page, db: Db, sessionId: string): Promise<Machine> {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, sessionId, sub);
		const started = await startMachine({ sub });
		await page.goto(`${E2E_APP_BASE}/code`);
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.getByText(started.name)).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: "Confirm this machine" }).click();
		await page.getByRole("button", { name: "Add a workspace to this device" }).click();
		await page.getByLabel("Directory on the machine").fill(started.workspace);
		await page.getByLabel("Title (optional)").fill("repo");
		await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
		await page.getByRole("button", { name: "Start a coding session in this workspace" }).click();
		await page.getByRole("button", { name: "Build" }).click();
		await page.getByRole("button", { name: "Create agent" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByRole("combobox")).toBeEnabled({ timeout: 30_000 });
		return started;
	}

	async function send(page: Page, text: string): Promise<void> {
		await page.getByRole("combobox").fill(text);
		await page.getByRole("button", { name: "Send message" }).click();
	}

	test("fork from an earlier turn: dialog prefilled, new session carries the history cut there", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		const transcript = page.locator('[data-message-role="assistant"]');
		const settle = () =>
			expect(page.getByText("done", { exact: true }).first()).toBeVisible({ timeout: 60_000 });

		await mockOpenAI.setDefaultScenario({ content: ["Answer", " one."], chunkDelayMs: 5 });
		await send(page, "first question");
		await expect(transcript.getByText("Answer one.")).toBeVisible({ timeout: 60_000 });
		await settle();

		await mockOpenAI.setDefaultScenario({ content: ["Answer", " two."], chunkDelayMs: 5 });
		await send(page, "second question");
		await expect(transcript.getByText("Answer two.")).toBeVisible({ timeout: 60_000 });
		await settle();

		// The fork is offered on BOTH answers, not only the last one.
		const firstAnswer = transcript.first();
		await firstAnswer.hover();
		await firstAnswer.getByRole("button", { name: "Fork from here" }).click();

		// The dialog opened, prefilled from the source.
		await expect(page.getByRole("heading", { name: "Fork from here" })).toBeVisible();
		await expect(page.getByText(/^From /)).toBeVisible();
		await expect(page.getByLabel("Carry the conversation up to here")).toBeChecked();

		await page.getByLabel("Prompt").fill("keep going on this");
		await page.getByRole("button", { name: "Fork", exact: true }).click();

		// Landed in the new "Fork: …" session, which names its source.
		await page.waitForURL(/agent=/);
		await expect(page.getByText("Forked from")).toBeVisible({ timeout: 60_000 });

		// The new session's first prompt carried the chat history cut at the
		// forked message: turn one's exchange is in there, turn two's is not.
		// The attachment rides as a data URL, so read any markdown payloads
		// out of the recorded request bodies before matching.
		let carried: { hasFirst: boolean; hasSecond: boolean } | null = null;
		await expect
			.poll(
				async () => {
					const bodies = (await mockOpenAI.requests())
						.filter((r) => JSON.stringify(r.body).includes("keep going on this"))
						.map((r) => JSON.stringify(r.body));
					if (bodies.length === 0) return null;
					const decoded = bodies.map((body) => {
						let text = body;
						for (const match of body.matchAll(/data:text\/markdown;base64,([A-Za-z0-9+/=]+)/g)) {
							text += Buffer.from(match[1], "base64").toString("utf8");
						}
						return text;
					});
					carried = {
						hasFirst: decoded.some(
							(t) => t.includes("first question") && t.includes("Answer one.")
						),
						hasSecond: decoded.some(
							(t) => t.includes("second question") || t.includes("Answer two.")
						),
					};
					return carried;
				},
				{ timeout: 30_000 }
			)
			.toMatchObject({ hasFirst: true, hasSecond: false });
		expect(carried).toMatchObject({ hasFirst: true, hasSecond: false });
	});
});
