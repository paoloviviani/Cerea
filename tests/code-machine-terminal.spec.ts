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
		await page.getByRole("button", { name: "Create agent" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
	}

	/** Opening the Terminal tab only shows the (possibly empty) roster — a
	 * terminal only exists once "+ New" is clicked, and opening asks
	 * nothing. */
	async function openTerminalTab(page: import("playwright/test").Page) {
		await page.getByRole("button", { name: "Terminal", exact: true }).click();
		await page.getByRole("button", { name: "New", exact: true }).click();
		// The one-time "a terminal is a full shell" acknowledgement no
		// longer exists; assert its absence so a regression fails loudly.
		await expect(page.getByRole("heading", { name: "A terminal is a full shell" })).toHaveCount(0);
		await expect(page.getByTestId("code-terminal")).toBeVisible({ timeout: 30_000 });
		await shellPrompt(page);
	}

	/** The wrapper shows before xterm's lazy imports land and before the socket is open, and a
	 * click or keystroke in that gap goes nowhere (typed input is dropped on a closed socket).
	 * The shell's own prompt is the sign both are done; xterm's hidden character-measure row is
	 * all dollar signs, so the prompt is matched by its user@host shape. */
	async function shellPrompt(page: import("playwright/test").Page) {
		await expect(page.getByTestId("code-terminal")).toContainText(/\w+@[\w.-]+:/, {
			timeout: 30_000,
		});
	}

	/** A terminal opened with "New" while an exited one was showing: the exited pane (its banner)
	 * is gone and the new shell has printed its prompt. */
	async function freshShell(page: import("playwright/test").Page) {
		await expect(page.getByText(/Exited/)).toHaveCount(0);
		await shellPrompt(page);
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

		// Resize: a wider viewport widens the terminal, and the new width reaches the shell. The
		// side pane is a share of the window, so no number is asserted: the width xterm drew
		// (its screen over one measured cell) is what `tput cols` must come to. Asking again until
		// they agree absorbs the resize frame's trip to the machine, which the first answer may
		// not yet reflect; the width only has to settle, never to be asked at the right instant.
		const drawnCols = () =>
			page.evaluate(() => {
				const screen = document.querySelector(".xterm-screen")?.getBoundingClientRect().width;
				const probe = document
					.querySelector(".xterm-char-measure-element")
					?.getBoundingClientRect().width;
				return screen && probe ? Math.round(screen / (probe / 32)) : 0;
			});
		const before = await drawnCols();
		expect(before).toBeGreaterThan(0);
		await page.setViewportSize({ width: 1600, height: 900 });
		await expect.poll(drawnCols, { timeout: 15_000 }).toBeGreaterThan(before);
		let agreed = false;
		for (let attempt = 0; attempt < 6 && !agreed; attempt++) {
			await page.keyboard.type("tput cols");
			await page.keyboard.press("Enter");
			const want = await drawnCols();
			agreed = await expect(term)
				.toContainText(new RegExp(`tput cols${want}(?!\\d)`), { timeout: 3_000 })
				.then(
					() => true,
					() => false
				);
		}
		expect(agreed, "the shell never reported the width xterm drew").toBe(true);

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

	/** Closes the side pane (clicking the "Terminal" toggle again), then
	 * reopens it — a fresh mount of CodeTerminals, exactly what the reported
	 * bug needs: a terminal that exited while the pane was shut must come
	 * back in the roster fetched on that fresh mount, not from anything the
	 * component remembered in memory. */
	async function closeAndReopenPane(page: import("playwright/test").Page) {
		await page.getByRole("button", { name: "Terminal", exact: true }).click();
		await page.getByRole("button", { name: "Terminal", exact: true }).click();
	}

	test("exit, close the pane, reopen it: the exited terminal never comes back live", async ({
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
		await page.keyboard.type("exit");
		await page.keyboard.press("Enter");
		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 15_000 });

		await closeAndReopenPane(page);

		// Still shown as exited (code, Restart only) — never a live,
		// attachable tab (no fresh "code-terminal" xterm view mounted).
		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("button", { name: "Restart" })).toBeVisible();
	});

	test("Ctrl+D, close the pane, reopen it: the exited terminal never comes back live", async ({
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
		await page.keyboard.press("Control+D");
		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 15_000 });

		await closeAndReopenPane(page);

		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("button", { name: "Restart" })).toBeVisible();
	});

	test("the UI close button on an exited terminal removes it for good", async ({
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
		await page.keyboard.type("exit");
		await page.keyboard.press("Enter");
		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 15_000 });

		await page.getByRole("button", { name: "Close terminal", exact: true }).click();
		await expect(page.getByText("No terminals open in this workspace.")).toBeVisible();

		// Not just gone from this mount's in-memory list — gone from the
		// machine's own roster, so a fresh pane open doesn't bring it back.
		await closeAndReopenPane(page);
		await expect(page.getByText("No terminals open in this workspace.")).toBeVisible();
	});

	test("exiting doesn't use up a maxTerminals slot", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machine = await startMachine({ sub, policy: { terminal: "allowed", maxTerminals: 2 } });

		await pairAndOpenWorkspace(page, machine);
		await openTerminalTab(page);

		// Exit the first terminal.
		let term = page.getByTestId("code-terminal");
		await term.click();
		await page.keyboard.type("exit");
		await page.keyboard.press("Enter");
		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 15_000 });

		// Open and exit a second terminal — both now retained by galopin
		// (state "exited"), at the maxTerminals=2 cap.
		await page.getByRole("button", { name: "New", exact: true }).click();
		term = page.getByTestId("code-terminal");
		await expect(term).toBeVisible({ timeout: 15_000 });
		await freshShell(page);
		await term.click();
		await page.keyboard.type("exit");
		await page.keyboard.press("Enter");
		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 15_000 });

		// A third open must succeed: exited terminals must not count against
		// maxTerminals, or a user who exits every shell could never open a
		// fresh one until the 10-minute retention window passed.
		await page.getByRole("button", { name: "New", exact: true }).click();
		term = page.getByTestId("code-terminal");
		await expect(term).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("Could not open a terminal.")).not.toBeVisible();
		await freshShell(page);
		await term.click();
		await page.keyboard.type("echo maxslot-ok");
		await page.keyboard.press("Enter");
		await expect(term).toContainText("maxslot-ok", { timeout: 15_000 });
	});
});
