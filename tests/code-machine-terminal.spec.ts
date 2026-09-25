/**
 * The terminal (ADR 0090, PROTOCOL.md §9) against a real machine: nothing
 * stubbed between the browser and the shell galopin's PTY runs. Covers the
 * arithmetic smoke, a resize actually reaching the shell, the exit state,
 * reattach with scrollback after a reload, coexistence with a running
 * session turn, and a policy-denied machine's disabled entry.
 */
import { randomUUID } from "node:crypto";
import { test, expect, E2E_APP_BASE } from "./fixtures";
import { opencodeAvailable, seedUser, startMachine, type Machine } from "./machineHarness";

test.describe("the terminal on a real machine", () => {
	test.skip(!opencodeAvailable(), "needs the opencode binary on PATH");
	test.describe.configure({ mode: "serial", timeout: 120_000 });

	let machine: Machine | null = null;

	// eslint-disable-next-line no-empty-pattern
	test.afterEach(async ({}, testInfo) => {
		if (machine && testInfo.status !== testInfo.expectedStatus) {
			await testInfo.attach("galopin.log", { body: machine.logs(), contentType: "text/plain" });
		}
		await machine?.stop();
		machine = null;
	});

	async function pairAndOpenWorkspace(page: import("playwright/test").Page, m: Machine) {
		await page.goto(`${E2E_APP_BASE}/code`);
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.getByText(m.name)).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: "Confirm this machine" }).click();
		await page.getByRole("button", { name: "Add a workspace to this device" }).click();
		await page.getByLabel("Directory on the machine").fill(m.workspace);
		await page.getByLabel("Title (optional)").fill("repo");
		await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
		await expect(page.getByText("repo", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Start a coding session in this workspace" }).click();
		await page.getByRole("button", { name: "Write" }).click();
		await page.getByRole("button", { name: "Create agent" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
	}

	async function openTerminalTab(page: import("playwright/test").Page) {
		await page.getByRole("button", { name: "Terminal", exact: true }).click();
		const ackDialog = page.getByRole("heading", { name: "A terminal is a full shell" });
		if (await ackDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
			await page.getByRole("button", { name: "I understand" }).click();
		}
		await expect(page.getByTestId("code-terminal")).toBeVisible({ timeout: 30_000 });
	}

	test("echo $((6*7)) → 42, a resize follows through, exit shows the exit state", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machine = await startMachine({ sub, policy: { terminal: "allowed" } });

		await pairAndOpenWorkspace(page, machine);
		await openTerminalTab(page);

		const term = page.getByTestId("code-terminal");
		await term.click();
		await page.keyboard.type("echo $((6*7))");
		await page.keyboard.press("Enter");
		await expect(term).toContainText("42", { timeout: 15_000 });

		// Resize: a wide viewport should widen the pty (`tput cols` prints it).
		await page.setViewportSize({ width: 1600, height: 900 });
		await page.keyboard.type("tput cols");
		await page.keyboard.press("Enter");
		await expect(term).toContainText(/\b(1\d\d|2\d\d)\b/, { timeout: 15_000 });

		await page.keyboard.type("exit");
		await page.keyboard.press("Enter");
		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 15_000 });
	});

	test("reload reattaches with scrollback", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machine = await startMachine({ sub, policy: { terminal: "allowed" } });

		await pairAndOpenWorkspace(page, machine);
		await openTerminalTab(page);

		const term = page.getByTestId("code-terminal");
		await term.click();
		await page.keyboard.type("echo scrollback-marker-12345");
		await page.keyboard.press("Enter");
		await expect(term).toContainText("scrollback-marker-12345", { timeout: 15_000 });

		await page.reload();
		await expect(page.getByTestId("code-terminal")).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("code-terminal")).toContainText("scrollback-marker-12345", {
			timeout: 15_000,
		});
	});

	test("coexistence: a busy terminal doesn't stall a streaming session turn", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machine = await startMachine({ sub, policy: { terminal: "allowed" } });
		await mockOpenAI.setDefaultScenario({
			content: Array.from({ length: 20 }, (_, i) => `tok${i} `),
			chunkDelayMs: 50,
			finishReason: "stop",
		});

		await pairAndOpenWorkspace(page, machine);
		await openTerminalTab(page);
		const term = page.getByTestId("code-terminal");
		await term.click();
		await page.keyboard.type("yes | head -c 50000000 > /dev/null");
		await page.keyboard.press("Enter");

		// The side pane (Terminal) and the composer are independent surfaces;
		// no need to switch tabs to reach it.
		const box = page.getByRole("combobox");
		await box.fill("talk a bit");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("tok19")).toBeVisible({ timeout: 30_000 });
	});

	test("a policy-denied machine shows the disabled Terminal entry", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machine = await startMachine({ sub, policy: { terminal: "denied" } });

		await pairAndOpenWorkspace(page, machine);
		const terminalButton = page.getByRole("button", { name: "Terminal", exact: true });
		await expect(terminalButton).toBeVisible();
		await expect(terminalButton).toBeDisabled();
	});
});
