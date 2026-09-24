/**
 * Parity milestones against a real machine (the same chain as the P0 spec: the real
 * `pystino-agent` supervising a real `opencode serve`, only the LLM and the IdP mocked).
 * Each test pairs its own machine, so a policy set for one never leaks into another.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE } from "./fixtures";
import {
	opencodeAvailable,
	seedUser,
	startMachine,
	type Machine,
	type MachinePolicy,
} from "./machineHarness";
import type { Db } from "mongodb";

test.describe("owned machine agent: parity", () => {
	test.skip(!opencodeAvailable(), "needs the opencode binary on PATH");
	test.describe.configure({ mode: "serial", timeout: 180_000 });

	let machine: Machine | null = null;
	let consoleLines: string[] = [];

	test.beforeEach(({ page }) => {
		consoleLines = [];
		page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
		page.on("pageerror", (err) => consoleLines.push(`[pageerror] ${err.stack ?? err.message}`));
	});

	// eslint-disable-next-line no-empty-pattern
	test.afterEach(async ({}, testInfo) => {
		if (machine && testInfo.status !== testInfo.expectedStatus) {
			await testInfo.attach("pystino-agent.log", {
				body: machine.logs(),
				contentType: "text/plain",
			});
			// Also on disk: an attachment's body lives only in the report.
			writeFileSync(testInfo.outputPath("pystino-agent.log"), machine.logs());
			writeFileSync(testInfo.outputPath("browser-console.log"), consoleLines.join("\n"));
		}
		await machine?.stop();
		machine = null;
	});

	/** Pair a fresh machine, add its repo as a workspace and open a new session. */
	async function openSession(
		page: Page,
		db: Db,
		sessionId: string,
		policy?: MachinePolicy
	): Promise<Machine> {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, sessionId, sub);
		const started = await startMachine({ sub, policy });
		machine = started;
		await page.goto(`${E2E_APP_BASE}/code`);
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.getByText(started.name)).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: "Confirm this machine" }).click();
		await page.getByRole("button", { name: "Add a workspace to this device" }).click();
		await page.getByLabel("Directory on the machine").fill(started.workspace);
		await page.getByLabel("Title (optional)").fill("repo");
		await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
		await page.getByRole("button", { name: "Start a coding session in this workspace" }).click();
		await page.getByRole("button", { name: "Write" }).click();
		await page.getByRole("button", { name: "Create agent" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByRole("combobox")).toBeEnabled({ timeout: 30_000 });
		return started;
	}

	async function send(page: Page, text: string): Promise<void> {
		await page.getByRole("combobox").fill(text);
		await page.getByRole("button", { name: "Send message" }).click();
	}

	const writeFileScenario = {
		toolCalls: [
			{
				id: "call_w",
				name: "bash",
				arguments: JSON.stringify({ command: "echo parity > out.txt", description: "write" }),
			},
		],
		content: ["Wrote", " it", "."],
		chunkDelayMs: 10,
		finishReason: "stop" as const,
	};

	test("models: only gateway models are offered, and the pill says how many were hidden", async ({
		page,
		db,
		session,
	}) => {
		await openSession(page, db, session.sessionId);
		await page.getByRole("button", { name: "Model" }).click();
		await expect(page.getByRole("menuitem", { name: "Mock Model" })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "Free Model" })).toHaveCount(0);
		// opencode lists its own free catalog as well as the harness's "freebie" provider.
		await expect(page.getByText(/\d+ non-gateway models? hidden/)).toBeVisible();
	});

	test("auto-accept: absent under the default policy", async ({ page, db, session }) => {
		await openSession(page, db, session.sessionId);
		await expect(page.getByRole("button", { name: /auto.?accept/i })).toHaveCount(0);
	});

	test("auto-accept: a machine that allows it runs tools without asking, and the diff shows the change", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const m = await openSession(page, db, session.sessionId, { autoAccept: "allowed" });
		await page.getByRole("button", { name: /auto.?accept/i }).click();
		await mockOpenAI.setDefaultScenario(writeFileScenario);
		await send(page, "write the file");
		await expect(page.getByText("Wrote it.")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("wants to call")).toHaveCount(0);
		expect(existsSync(join(m.workspace, "out.txt"))).toBe(true);

		await page.getByRole("button", { name: "Changes" }).click();
		await expect(page.getByText("out.txt").first()).toBeVisible({ timeout: 20_000 });
	});

	test("files: an attached file reaches the agent and renders on the user message", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario({
			content: ["Read", " it", "."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await page.locator('input[type="file"]').setInputFiles({
			name: "notes.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("marker-7f3a lives in the notes\n"),
		});
		await send(page, "read the notes");
		await expect(page.getByText("Read it.")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("notes.txt").first()).toBeVisible();
		// The bytes went through the store, over the machine's socket, into opencode's prompt.
		const requests = await mockOpenAI.requests();
		expect(requests.some((r) => JSON.stringify(r.body).includes("marker-7f3a"))).toBe(true);
	});

	test("subagents: a task call renders as a subagent card in the parent transcript", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await openSession(page, db, session.sessionId);
		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{
					id: "call_task",
					name: "task",
					arguments: JSON.stringify({
						description: "Inspect the repo",
						prompt: "List what is in the repo.",
						subagent_type: "general",
					}),
				},
			],
			toolCallsOnce: true,
			content: ["Subagent", " done", "."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await send(page, "delegate this");
		await expect(page.getByText("Inspect the repo").first()).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("Subagent done.").first()).toBeVisible({ timeout: 60_000 });

		// Expanding the card loads the child session's own transcript through the
		// machine: its first message is the prompt the parent's task call gave it.
		await page.getByRole("button", { name: "Expand Inspect the repo" }).click();
		await expect(page.getByText("List what is in the repo.")).toBeVisible({ timeout: 30_000 });
	});
});
