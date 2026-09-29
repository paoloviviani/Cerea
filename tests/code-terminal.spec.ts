/**
 * The terminal (ADR 0090, PROTOCOL.md §9), hermetic: a `FakeMachine`
 * connected to the real running app's `/api/v2/code/machine` endpoint with
 * a token from the mock OIDC issuer (the same minting `machineHarness.ts`
 * uses for the real-machine specs), so nothing here needs galopin or
 * opencode. The fake's own terminal support (open/attach/resize/close,
 * binary echo, credits, `evictTerminalRing` for a forced reset,
 * `exitTerminal` for a spontaneous shell exit) is in `tests/fake-machine.ts`.
 */
import { randomUUID } from "node:crypto";
import { test, expect, E2E_APP_BASE, E2E_APP_URL, MOCK_OIDC_ISSUER } from "./fixtures";
import { seedUser } from "./machineHarness";
import { FakeMachine } from "./fake-machine";
import type { Page } from "playwright/test";
import type { Policy } from "../src/lib/types/machineProtocol";

const TERMINAL_ALLOWED_POLICY: Policy = {
	autoAccept: "denied",
	workspaceRoots: [],
	allowFreeModels: false,
	terminal: "allowed",
};
const TERMINAL_DENIED_POLICY: Policy = { ...TERMINAL_ALLOWED_POLICY, terminal: "denied" };

async function mintMachineToken(sub: string): Promise<string> {
	const res = await fetch(`${MOCK_OIDC_ISSUER}/__control/mint`, {
		method: "POST",
		body: JSON.stringify({ sub }),
	});
	const { access_token: accessToken } = (await res.json()) as { access_token: string };
	return accessToken;
}

async function connectFakeMachine(
	sub: string,
	name: string,
	policy: Policy = TERMINAL_ALLOWED_POLICY
): Promise<FakeMachine> {
	const token = await mintMachineToken(sub);
	const wsUrl = `${E2E_APP_URL.replace(/^http/, "ws")}/api/v2/code/machine`;
	const fake = new FakeMachine(
		wsUrl,
		{
			authorization: `Bearer ${token}`,
			"x-pystino-machine-id": randomUUID(),
			"x-pystino-machine-name": name,
		},
		{ machine: { capabilities: { terminal: true } }, policy }
	);
	await fake.hello();
	return fake;
}

async function pairAndOpenWorkspace(page: Page, name: string) {
	await page.goto(`${E2E_APP_BASE}/code`);
	await page.getByRole("button", { name: "Agents", exact: true }).click();
	await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Confirm this machine" }).click();
	await page.getByRole("button", { name: "Add a workspace to this device" }).click();
	await page.getByLabel("Directory on the machine").fill("/repo");
	await page.getByLabel("Title (optional)").fill("repo");
	await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
	await expect(page.getByText("repo", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Start a coding session in this workspace" }).click();
	await page.getByRole("button", { name: "Write" }).click();
	await page.getByRole("button", { name: "Create agent" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function openTerminalTab(page: Page) {
	await page.getByRole("button", { name: "Terminal", exact: true }).click();
}

/** The side pane's own toggle, disambiguated from a terminal tab that
 * happens to be titled "Terminal" too (the fake's default title, unlike a
 * real machine's default of the workspace name) — the toggle's `title`
 * attribute is the one thing that never collides with a tab's own label. */
async function togglePane(page: Page) {
	await page.getByTitle("Open a shell on this workspace").click();
}

/** Opening the Terminal tab only shows the (possibly empty) roster — a
 * terminal only exists once "+ New" is clicked, and opening asks nothing. */
async function clickNewTerminal(page: Page) {
	await page.getByRole("button", { name: "New", exact: true }).click();
}

async function acknowledgeIfShown(page: Page) {
	// The one-time "a terminal is a full shell" acknowledgement no longer
	// exists. Kept as a guard so an unexpected dialog fails loudly instead
	// of hanging the run.
	await expect(page.getByRole("heading", { name: "A terminal is a full shell" })).toHaveCount(0);
}

/** The one terminal a test has opened so far, read off the fake's own
 * model — the id the UI never exposes directly. */
function soleTerminalId(fake: FakeMachine): string {
	const ids = [...fake.model.terminals.keys()];
	if (ids.length !== 1) throw new Error(`expected exactly one terminal, found ${ids.length}`);
	return ids[0];
}

/** The relay's `terminal.attach` is a real (if fast) round trip, done
 * asynchronously after the viewport mounts — typing before it lands would
 * be dropped server-side (no channel registered yet), same as it would be
 * against a real machine. Polling the fake's own viewer count is the one
 * way to know the attach actually landed, rather than a guessed delay. */
async function waitForAttach(fake: FakeMachine, terminalId: string): Promise<void> {
	await expect
		.poll(() => fake.model.terminals.get(terminalId)?.viewers.size ?? 0, { timeout: 10_000 })
		.toBeGreaterThan(0);
}

test.describe("the terminal, hermetic", () => {
	let fake: FakeMachine | null = null;

	test.afterEach(() => {
		fake?.close();
		fake = null;
	});

	test("a policy-denied machine shows the disabled entry with the exact flag", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `denied-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name, TERMINAL_DENIED_POLICY);

		await pairAndOpenWorkspace(page, name);
		const button = page.getByRole("button", { name: "Terminal", exact: true });
		await expect(button).toBeVisible();
		await expect(button).toBeDisabled();
		await expect(button).toHaveAttribute(
			"title",
			"This machine was enrolled without --allow-terminal. Re-enroll with it to use terminals here."
		);
	});

	test("open, type, echo, resize", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `term-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await pairAndOpenWorkspace(page, name);
		await openTerminalTab(page);
		await clickNewTerminal(page);

		const term = page.getByTestId("code-terminal");
		await expect(term).toBeVisible({ timeout: 15_000 });
		await waitForAttach(fake, soleTerminalId(fake));
		await term.click();
		const marker = `echo-${randomUUID().slice(0, 8)}`;
		await page.keyboard.type(marker);
		await expect(term).toContainText(marker, { timeout: 10_000 });

		// A resize reaches the machine as terminal.resize.
		const resizeArgs: Array<{ cols: number; rows: number }> = [];
		fake.onOp("terminal.resize", (args: { cols: number; rows: number }) => {
			resizeArgs.push(args);
			return { applied: true };
		});
		await page.setViewportSize({ width: 1600, height: 1000 });
		await expect(page.locator("body")).toBeVisible(); // let layout settle
		await expect.poll(() => resizeArgs.length, { timeout: 10_000 }).toBeGreaterThan(0);
	});

	test("reload reattaches with the prior output present exactly once", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `term-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await pairAndOpenWorkspace(page, name);
		await openTerminalTab(page);
		await clickNewTerminal(page);
		await acknowledgeIfShown(page);
		const term = page.getByTestId("code-terminal");
		await expect(term).toBeVisible({ timeout: 15_000 });
		const terminalId = soleTerminalId(fake);
		await waitForAttach(fake, terminalId);
		await term.click();
		const marker = `reload-marker-${randomUUID().slice(0, 8)}`;
		await page.keyboard.type(marker);
		await expect(term).toContainText(marker, { timeout: 10_000 });

		await page.reload();
		const reattached = page.getByTestId("code-terminal");
		await expect(reattached).toBeVisible({ timeout: 15_000 });
		// The reattach after reload is a fresh channel (a real
		// terminal.attach round trip) — waiting for it here, same as "a
		// forced reset path" does, rather than trusting toContainText's own
		// polling to paper over an attach that hasn't landed yet.
		await waitForAttach(fake, terminalId);
		// The replay itself is prompt once attached (confirmed by tracing
		// the wire frames directly: the reset control frame and the whole
		// backlog in one term.output frame arrive back to back, no
		// meaningful gap) — this assertion's own generous timeout is
		// candidly about a shared, contended box under sequential test
		// load, not the mechanism itself.
		await expect(reattached).toContainText(marker, { timeout: 25_000 });
		const text = await reattached.innerText();
		const occurrences = text.split(marker).length - 1;
		expect(occurrences).toBe(1);
	});

	// A plain reload already always attaches with `from` undefined (a fresh
	// page has no memory of the last offset xterm wrote), which is itself a
	// reset per §9.3 — so this and "reload reattaches…" share a mechanism.
	// What this case adds is the ring having actually been evicted first:
	// old content must not reappear stale, and content pushed after the
	// eviction must still show up cleanly through the reset+replay path.
	test("a forced reset path", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `term-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await pairAndOpenWorkspace(page, name);
		await openTerminalTab(page);
		await clickNewTerminal(page);
		await acknowledgeIfShown(page);
		const term = page.getByTestId("code-terminal");
		await expect(term).toBeVisible({ timeout: 15_000 });
		const terminalId = soleTerminalId(fake);
		await waitForAttach(fake, terminalId);
		await term.click();
		const beforeReset = `before-reset-${randomUUID().slice(0, 8)}`;
		await page.keyboard.type(beforeReset);
		await expect(term).toContainText(beforeReset, { timeout: 10_000 });

		// Evict the ring past everything produced so far: the next attach
		// (the reload below) must come back as a reset, not a resume.
		fake.evictTerminalRing(terminalId, fake.model.terminals.get(terminalId)?.history.length ?? 0);

		await page.reload();
		await expect(page.getByTestId("code-terminal")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("code-terminal")).not.toContainText(beforeReset);
		// The reattach after reload is a fresh channel (a real terminal.attach
		// round trip) — pushing before it lands would have no registered
		// viewer to deliver to, and the bytes would simply be dropped.
		await waitForAttach(fake, terminalId);

		const afterReset = `after-reset-${randomUUID().slice(0, 8)}`;
		fake.pushTerminalOutput(terminalId, Buffer.from(afterReset));
		await expect(page.getByTestId("code-terminal")).toContainText(afterReset, { timeout: 10_000 });
	});

	test("the exit state", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `term-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await pairAndOpenWorkspace(page, name);
		await openTerminalTab(page);
		await clickNewTerminal(page);
		await acknowledgeIfShown(page);
		await expect(page.getByTestId("code-terminal")).toBeVisible({ timeout: 15_000 });

		const terminalId = soleTerminalId(fake);
		await waitForAttach(fake, terminalId);
		fake.exitTerminal(terminalId, 0);

		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 10_000 });
		await expect(page.getByRole("button", { name: "Restart" })).toBeVisible();
	});

	test("exit, close the pane, reopen it: the exited terminal never comes back live", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `term-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await pairAndOpenWorkspace(page, name);
		await openTerminalTab(page);
		await clickNewTerminal(page);
		await acknowledgeIfShown(page);
		await expect(page.getByTestId("code-terminal")).toBeVisible({ timeout: 15_000 });

		const terminalId = soleTerminalId(fake);
		await waitForAttach(fake, terminalId);
		fake.exitTerminal(terminalId, 0);
		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 10_000 });

		// Close the side pane (not the terminal tab itself) — a fresh mount of
		// CodeTerminals, which must read the roster's own `state`, not just
		// the notice this mount already saw.
		await togglePane(page);
		await togglePane(page);

		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 10_000 });
		await expect(page.getByRole("button", { name: "Restart" })).toBeVisible();
		// Never a live, attachable tab: no fresh attach round trip for it.
		expect(fake.model.terminals.get(terminalId)?.viewers.size ?? 0).toBe(0);
	});

	test("the UI close button on an exited terminal removes it for good", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `term-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await pairAndOpenWorkspace(page, name);
		await openTerminalTab(page);
		await clickNewTerminal(page);
		await acknowledgeIfShown(page);
		await expect(page.getByTestId("code-terminal")).toBeVisible({ timeout: 15_000 });

		const terminalId = soleTerminalId(fake);
		await waitForAttach(fake, terminalId);
		fake.exitTerminal(terminalId, 0);
		await expect(page.getByText(/Exited/)).toBeVisible({ timeout: 10_000 });

		await page.getByRole("button", { name: "Close terminal" }).click();
		await expect(page.getByText("No terminals open in this workspace.")).toBeVisible();
		await expect.poll(() => fake?.model.terminals.has(terminalId)).toBe(false);

		// Gone from the machine's own roster, so a fresh pane open doesn't
		// bring it back.
		await togglePane(page);
		await togglePane(page);
		await expect(page.getByText("No terminals open in this workspace.")).toBeVisible();
	});

	test("multiple tabs", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `term-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await pairAndOpenWorkspace(page, name);
		await openTerminalTab(page);
		await clickNewTerminal(page);
		await acknowledgeIfShown(page);
		await expect(page.getByTestId("code-terminal")).toBeVisible({ timeout: 15_000 });
		const firstId = soleTerminalId(fake);
		await waitForAttach(fake, firstId);

		await page.getByRole("button", { name: "New", exact: true }).click();
		await expect.poll(() => fake?.model.terminals.size ?? 0, { timeout: 10_000 }).toBe(2);
		const secondId = [...fake.model.terminals.keys()].find((id) => id !== firstId) as string;
		await waitForAttach(fake, secondId);

		// The newly-opened tab is the active one: typing here must reach the
		// second terminal, not the first.
		const marker = `tab2-${randomUUID().slice(0, 6)}`;
		await page.getByTestId("code-terminal").click();
		await page.keyboard.type(marker);
		await expect(page.getByTestId("code-terminal")).toContainText(marker, { timeout: 10_000 });
		expect(fake.model.terminals.get(firstId)?.history.toString()).not.toContain(marker);
	});
});
