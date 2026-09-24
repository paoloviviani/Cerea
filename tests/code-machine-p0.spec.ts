/**
 * P0 of the owned machine agent, end to end with nothing stubbed between the
 * browser and opencode: the real `pystino-agent` dials the app over WSS with a
 * token from the mock issuer, the person confirms the machine in /code, adds a
 * workspace, starts a session, sends a prompt and watches the reply stream in,
 * approves a permission (the tool really runs on disk), and stops a running turn.
 *
 * The LLM is the hermetic mock-openai, scripted through its default scenario:
 * opencode sends no conversation header, so per-conversation keys don't apply.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures";
import { opencodeAvailable, seedUser, startMachine, type Machine } from "./machineHarness";

test.describe("owned machine agent (P0)", () => {
	test.skip(!opencodeAvailable(), "needs the opencode binary on PATH");
	// One real machine for the whole flow: pairing, prompt, permission and stop are the
	// steps one person takes in order, and opencode's startup dominates the cost.
	test.describe.configure({ mode: "serial", timeout: 180_000 });

	let machine: Machine | null = null;

	// eslint-disable-next-line no-empty-pattern
	test.afterEach(async ({}, testInfo) => {
		if (machine && testInfo.status !== testInfo.expectedStatus) {
			await testInfo.attach("pystino-agent.log", {
				body: machine.logs(),
				contentType: "text/plain",
			});
		}
		await machine?.stop();
		machine = null;
	});

	test("pair, prompt, stream, approve a permission, stop", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		await mockOpenAI.setDefaultScenario({
			content: ["Hello", " from", " the", " machine", "."],
			chunkDelayMs: 20,
			finishReason: "stop",
		});
		machine = await startMachine({ sub });

		// ── Pair: the machine appears pending; the person confirms it ──────────
		await page.goto("/code");
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		const pending = page.getByText(machine.name);
		await expect(pending).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: "Confirm this machine" }).click();

		// ── Workspace + session ────────────────────────────────────────────────
		await page.getByRole("button", { name: "Add a workspace to this device" }).click();
		await page.getByLabel("Directory on the machine").fill(machine.workspace);
		await page.getByLabel("Title (optional)").fill("repo");
		await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
		await expect(page.getByText("repo", { exact: true })).toBeVisible();

		await page.getByRole("button", { name: "Start a coding session in this workspace" }).click();
		await page.getByRole("button", { name: "Write" }).click();
		await page.getByRole("button", { name: "Create agent" }).click();

		// ── Prompt → streamed reply ────────────────────────────────────────────
		const box = page.getByRole("combobox");
		await box.fill("say hello");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("say hello")).toBeVisible();
		await expect(page.getByText("Hello from the machine.")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();

		// ── Permission: a bash call asks; approving runs it on disk ────────────
		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{
					id: "call_p0",
					name: "bash",
					arguments: JSON.stringify({ command: "echo approved > out.txt", description: "write" }),
				},
			],
			content: ["Wrote", " the", " file", "."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await box.fill("write the file");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("wants to call")).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: "Allow once" }).click();
		await expect(page.getByText("Wrote the file.")).toBeVisible({ timeout: 60_000 });
		const out = join(machine.workspace, "out.txt");
		expect(existsSync(out)).toBe(true);
		expect(readFileSync(out, "utf8").trim()).toBe("approved");

		// ── Stop: a long turn is cancelled from the composer ───────────────────
		await mockOpenAI.setDefaultScenario({
			content: Array.from({ length: 400 }, (_, i) => `tok${i} `),
			chunkDelayMs: 100,
			finishReason: "stop",
		});
		await box.fill("talk for a long time");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("tok3")).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: "Stop generating" }).click();
		await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
			timeout: 20_000,
		});
		await expect(page.getByText("tok399")).toHaveCount(0);
	});
});
