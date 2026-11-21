/**
 * The terminal (ADR 0090, PROTOCOL.md §9) against a real machine: nothing
 * stubbed between the browser and the shell galopin's PTY runs. Covers the
 * arithmetic smoke, a resize actually reaching the shell, the exit state,
 * reattach with scrollback after a reload, coexistence with a running
 * session turn, and a policy-denied machine's disabled entry.
 */
import { randomUUID } from "node:crypto";
import { paneButton } from "./codePanes";
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
		await page.getByRole("button", { name: "Confirm this computer" }).click();
		await page.getByRole("button", { name: "Add a workspace to this computer" }).click();
		await page.getByLabel("Directory on the computer").fill(m.workspace);
		await page.getByLabel("Title (optional)").fill("repo");
		await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
		await expect(page.getByRole("link", { name: /^repo/ })).toBeVisible();
		await page.getByRole("button", { name: "Start a session in this workspace" }).click();
		await page.getByRole("button", { name: "Start session" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
	}

	/** Opening the Terminal tab only shows the (possibly empty) roster — a
	 * terminal only exists once "+ New" is clicked, and opening asks
	 * nothing. */
	async function openTerminalTab(page: import("playwright/test").Page) {
		await (await paneButton(page, "Terminal")).click();
		await page.getByRole("button", { name: "New", exact: true }).click();
		// The one-time "a terminal is a full shell" acknowledgement no
		// longer exists; assert its absence so a regression fails loudly.
		await expect(page.getByRole("heading", { name: "A terminal is a full shell" })).toHaveCount(0);
		await expect(page.getByTestId("code-terminal")).toBeVisible({ timeout: 30_000 });
		await shellPrompt(page);
	}

	/** The wrapper shows before xterm's lazy imports land and before the socket is open, and a
	 * click or keystroke in that gap goes nowhere (typed input is dropped on a closed socket).
	 * The shell's prompt is no sign of readiness (it is "user@host:" under bash and a bare "#"
	 * under sh, as in CI's root container), and xterm's hidden character-measure row fills the
	 * text with one repeated character. So ask: type a marker until the shell echoes it back,
	 * which is proof the input arrived. */
	async function shellPrompt(page: import("playwright/test").Page) {
		const term = page.getByTestId("code-terminal");
		await expect
			.poll(
				async () => {
					if ((await term.textContent())?.includes("shell-ready")) return true;
					await term.click();
					await page.keyboard.type("echo shell-ready");
					await page.keyboard.press("Enter");
					return false;
				},
				{ timeout: 30_000, intervals: [1_000] }
			)
			.toBe(true);
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

	test("on a phone, a swipe scrolls the scrollback and jump-to-bottom returns", async ({
		page,
		db,
		session,
		browserName,
	}) => {
		test.skip(browserName !== "chromium", "real touch input goes through CDP, Chromium only");
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machine = await startMachine({ sub, policy: { terminal: "allowed" } });

		await pairAndOpenWorkspace(page, machine);
		await openTerminalTab(page);
		const term = page.getByTestId("code-terminal");
		await page.keyboard.type("seq 1 400");
		await page.keyboard.press("Enter");
		await expect(term).toContainText("400", { timeout: 15_000 });

		// iPhone 13 emulation: its viewport (below the mobile breakpoint, so
		// the view-mode key bar shows) and real touch input through CDP.
		await page.setViewportSize({ width: 390, height: 664 });
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		const jump = page.getByRole("button", { name: "Scroll to bottom" });
		await expect(jump).toHaveCount(0);

		// Below the breakpoint the terminal opens in a sheet: a new terminal view that connects
		// and replays the session's scrollback ("reset" plus prelude) some time after it mounts.
		// A swipe sent before the replay lands scrolls an empty buffer, and the replay then ends
		// at the bottom, so wait for the scrollback to be there, then for the box to stop moving.
		const screen = page.locator(".xterm-screen");
		await expect(term).toContainText("400", { timeout: 15_000 });
		let box = await screen.boundingBox();
		let steady = 0;
		await expect(async () => {
			const next = await screen.boundingBox();
			const same =
				!!box && !!next && next.x === box.x && next.y === box.y && next.height === box.height;
			box = next;
			steady = same ? steady + 1 : 0;
			expect(steady).toBeGreaterThanOrEqual(5);
		}).toPass({ timeout: 10_000, intervals: [100] });
		if (!box) throw new Error("no terminal screen");
		const x = box.x + box.width / 2;
		const touch = (type: "touchStart" | "touchMove" | "touchEnd", y: number) =>
			cdp.send("Input.dispatchTouchEvent", {
				type,
				touchPoints: type === "touchEnd" ? [] : [{ x, y }],
			});
		const y0 = box.y + 40;
		await touch("touchStart", y0);
		for (let i = 1; i <= 10; i++) {
			await touch("touchMove", y0 + i * 20);
			await page.waitForTimeout(16);
		}
		await touch("touchEnd", y0 + 200);

		await expect(jump).toBeVisible();
		await jump.click();
		await expect(jump).toHaveCount(0);

		// A tap (not a drag) opens the keyboard: typing then reaches the shell. The row text
		// has no newlines, so the typed "echo hi" followed by its output "hi" reads "echo hihi".
		await touch("touchStart", y0);
		await touch("touchEnd", y0);
		await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
		await page.keyboard.type("echo hi");
		await page.keyboard.press("Enter");
		await expect(term).toContainText("echo hihi", { timeout: 15_000 });
	});

	test("on a phone, Select text shows the buffer as plain text and Copy all fills the clipboard", async ({
		page,
		db,
		session,
		browserName,
	}) => {
		test.skip(browserName !== "chromium", "clipboard permissions and CDP touch, Chromium only");
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machine = await startMachine({ sub, policy: { terminal: "allowed" } });
		await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.emulateMedia({ colorScheme: "dark" });

		await pairAndOpenWorkspace(page, machine);
		await openTerminalTab(page);
		const term = page.getByTestId("code-terminal");
		await page.keyboard.type("seq 1 300; echo copy-marker-$((6*7))");
		await page.keyboard.press("Enter");
		await expect(term).toContainText("copy-marker-42", { timeout: 15_000 });

		await page.setViewportSize({ width: 412, height: 915 });
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await expect(term).toContainText("copy-marker-42", { timeout: 15_000 });

		await term.getByRole("button", { name: "Select text" }).click();
		const overlay = page.getByTestId("terminal-copy-overlay");
		const text = page.getByTestId("terminal-copy-text");
		await expect(overlay).toBeVisible();
		await expect(text).toContainText("copy-marker-42");
		// Scrollback, not just the screen: the first lines of seq are far above the viewport.
		const shown = (await text.textContent()) ?? "";
		expect(shown).toMatch(/\n1\n2\n3\n/);
		expect(shown).toMatch(/\n300\ncopy-marker-42/);
		// Native selection is allowed on it, and the terminal's typing path stays out of the way.
		expect(await text.evaluate((el) => getComputedStyle(el).userSelect)).toBe("text");
		// The hint is a full sentence on its own line, not truncated beside the buttons.
		const hint = overlay.getByRole("status");
		await expect(hint).toHaveText("Press and hold to select text.");
		expect(await hint.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		await page.screenshot({ path: "/var/tmp/termcopy-tmp/shots/copy-overlay.png" });
		// 360 px wide: the toolbar row fits and the page does not scroll sideways.
		await page.setViewportSize({ width: 360, height: 800 });
		await expect(overlay.getByRole("button", { name: "Close text view" })).toBeInViewport({
			ratio: 1,
		});
		await expect(hint).toBeInViewport({ ratio: 1 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
			)
		).toBe(true);
		await page.screenshot({ path: "/var/tmp/termcopy-tmp/shots/copy-overlay-360.png" });
		await page.setViewportSize({ width: 412, height: 915 });

		await overlay.getByRole("button", { name: "Copy all" }).click();
		await expect(overlay.getByRole("status")).toHaveText("Copied");
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);

		await overlay.getByRole("button", { name: "Copy visible screen" }).click();
		await expect(overlay.getByRole("status")).toHaveText("Copied");
		const visible = await page.evaluate(() => navigator.clipboard.readText());
		expect(visible).toContain("copy-marker-42");
		expect(visible).not.toMatch(/(^|\n)1\n2\n3\n/);
		expect(visible.length).toBeLessThan(shown.length);

		await overlay.getByRole("button", { name: "Close text view" }).click();
		await expect(overlay).toHaveCount(0);
		await expect(term).toContainText("copy-marker-42");
		await expect(page.getByRole("button", { name: "Scroll to bottom" })).toHaveCount(0);
		// Typing still works after the overlay closed.
		await term.locator(".xterm").click();
		await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
		await page.keyboard.type("echo after-copy");
		await page.keyboard.press("Enter");
		await expect(term).toContainText("echo after-copyafter-copy", { timeout: 15_000 });
	});

	test("on desktop, a selection in the terminal can be copied with Copy selection", async ({
		page,
		db,
		session,
		browserName,
	}) => {
		test.skip(browserName !== "chromium", "clipboard permissions, Chromium only");
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machine = await startMachine({ sub, policy: { terminal: "allowed" } });
		await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

		await pairAndOpenWorkspace(page, machine);
		await openTerminalTab(page);
		const term = page.getByTestId("code-terminal");
		await page.keyboard.type("echo sel-marker-$((6*7))");
		await page.keyboard.press("Enter");
		await expect(term).toContainText("sel-marker-42", { timeout: 15_000 });

		await expect(term.getByRole("button", { name: "Copy selection" })).toHaveCount(0);
		// Triple-click on the output row selects that whole line. Real mouse coordinates:
		// xterm's screen layer sits over its rows, so a click on the row element is intercepted.
		const row = await term
			.locator(".xterm-rows > div", { hasText: /^sel-marker-42$/ })
			.first()
			.boundingBox();
		if (!row) throw new Error("no output row");
		await page.mouse.click(row.x + 20, row.y + row.height / 2, { clickCount: 3 });
		const copy = term.getByRole("button", { name: "Copy selection" });
		await expect(copy).toBeVisible();
		await copy.click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("sel-marker-42");
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
		const terminalButton = await paneButton(page, "Terminal");
		await expect(terminalButton).toBeVisible();
		await expect(terminalButton).toBeDisabled();
	});

	/** Closes the side pane (clicking the "Terminal" toggle again), then
	 * reopens it — a fresh mount of CodeTerminals, exactly what the reported
	 * bug needs: a terminal that exited while the pane was shut must come
	 * back in the roster fetched on that fresh mount, not from anything the
	 * component remembered in memory. */
	async function closeAndReopenPane(page: import("playwright/test").Page) {
		await (await paneButton(page, "Terminal")).click();
		await (await paneButton(page, "Terminal")).click();
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
