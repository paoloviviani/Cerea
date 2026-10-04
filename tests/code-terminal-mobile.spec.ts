/**
 * The terminal's mobile extra-keys bar (§2.4 of
 * reports/2026-09-24-code-files-and-terminal-plan.md), at 390×844: view
 * mode by default (no keyboard, touch-scroll only), and an extra-keys bar
 * (Esc, Tab, sticky Ctrl/Alt, arrows, `|~/-`, A-/A+) that is always shown,
 * wrapped so every key is on screen, with Type/Done to raise and drop the
 * keyboard. Hermetic, on the
 * same `FakeMachine` and pairing flow as tests/code-terminal.spec.ts — see
 * that file for the wire-level detail this one doesn't repeat.
 *
 * The mobile nav drawer (MobileNav.svelte) renders its own copy of the tree
 * beside the desktop rail's hidden one (tests/code-dialogs-mobile.spec.ts's
 * own note), so every tree control here is addressed by its visible
 * instance; the drawer itself closes on every `goto()` the tree flow makes
 * (WorkspaceDialog/AgentDialog's "Navigation also closes the drawer"), so
 * the flow below reopens it between "Add workspace" and "Start a coding
 * session".
 */
import { randomUUID } from "node:crypto";
import { test, expect, E2E_APP_BASE, E2E_APP_URL, MOCK_OIDC_ISSUER } from "./fixtures";
import { seedUser } from "./machineHarness";
import { FakeMachine } from "./fake-machine";
import type { Page } from "playwright/test";
import type { Policy } from "../src/lib/types/machineProtocol";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

const TERMINAL_ALLOWED_POLICY: Policy = {
	workspaceRoots: [],
	allowFreeModels: false,
	terminal: "allowed",
};

async function mintMachineToken(sub: string): Promise<string> {
	const res = await fetch(`${MOCK_OIDC_ISSUER}/__control/mint`, {
		method: "POST",
		body: JSON.stringify({ sub }),
	});
	const { access_token: accessToken } = (await res.json()) as { access_token: string };
	return accessToken;
}

async function connectFakeMachine(sub: string, name: string): Promise<FakeMachine> {
	const token = await mintMachineToken(sub);
	const wsUrl = `${E2E_APP_URL.replace(/^http/, "ws")}/api/v2/code/machine`;
	const fake = new FakeMachine(
		wsUrl,
		{
			authorization: `Bearer ${token}`,
			"x-pystino-machine-id": randomUUID(),
			"x-pystino-machine-name": name,
		},
		{ machine: { capabilities: { terminal: true } }, policy: TERMINAL_ALLOWED_POLICY }
	);
	await fake.hello();
	return fake;
}

/** The drawer renders its own NavMenu/CodeNavTree beside the desktop rail's
 * hidden copy (present regardless of viewport) — every tree control is
 * addressed by its visible instance, same disambiguation as
 * code-dialogs-mobile.spec.ts's `visibleTreeButton`. */
function visibleTreeButton(page: Page, title: string) {
	return page.locator(`button[title='${title}']:visible`);
}

/** Same disambiguation as `visibleTreeButton`, for plain text nodes (a
 * device or workspace name) that also render twice. */
function visibleText(page: Page, text: string) {
	return page.locator(`:text-is("${text}"):visible`);
}

async function openAgentsPanel(page: Page) {
	await page.getByRole("button", { name: "Open Agents panel" }).click();
}

/** Pairs a fresh fake machine, adds one workspace and creates one agent —
 * the mobile path through the drawer, reopening it where a `goto()` (the
 * workspace and agent dialogs both navigate on success) closed it. */
async function pairAndOpenWorkspace(page: Page, name: string) {
	await page.goto(`${E2E_APP_BASE}/code`);
	await openAgentsPanel(page);
	await expect(visibleText(page, name)).toBeVisible({ timeout: 15_000 });
	await visibleTreeButton(page, "Confirm this machine").click();
	await visibleTreeButton(page, "Add a workspace to this device").click();
	await page.getByLabel("Directory on the machine").fill("/repo");
	await page.getByLabel("Title (optional)").fill("repo");
	await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);

	await openAgentsPanel(page);
	await visibleTreeButton(page, "Start a coding session in this workspace").click();
	await page.getByRole("dialog").getByRole("button", { name: "Create agent" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function openTerminalTab(page: Page) {
	await page.getByRole("button", { name: "Terminal", exact: true }).click();
}

async function clickNewTerminal(page: Page) {
	await page.getByRole("button", { name: "New", exact: true }).click();
}

async function acknowledgeIfShown(page: Page) {
	// The one-time "a terminal is a full shell" acknowledgement no longer
	// exists. Kept as a guard so an unexpected dialog fails loudly instead
	// of hanging the run.
	await expect(page.getByRole("heading", { name: "A terminal is a full shell" })).toHaveCount(0);
}

function soleTerminalId(fake: FakeMachine): string {
	const ids = [...fake.model.terminals.keys()];
	if (ids.length !== 1) throw new Error(`expected exactly one terminal, found ${ids.length}`);
	return ids[0];
}

async function waitForAttach(fake: FakeMachine, terminalId: string): Promise<void> {
	await expect
		.poll(() => fake.model.terminals.get(terminalId)?.viewers.size ?? 0, { timeout: 10_000 })
		.toBeGreaterThan(0);
}

/** Opens the terminal tab and its one terminal — opening asks nothing.
 * The state every test below starts from. */
async function openOneTerminal(page: Page, fake: FakeMachine): Promise<string> {
	await openTerminalTab(page);
	await clickNewTerminal(page);
	await acknowledgeIfShown(page);
	const term = page.getByTestId("code-terminal");
	await expect(term).toBeVisible({ timeout: 15_000 });
	const terminalId = soleTerminalId(fake);
	await waitForAttach(fake, terminalId);
	return terminalId;
}

function xtermTextarea(page: Page) {
	return page.locator(".xterm-helper-textarea");
}

test.describe("the terminal's mobile view/type/keys bar", () => {
	let fake: FakeMachine | null = null;

	test.afterEach(() => {
		fake?.close();
		fake = null;
	});

	test("opens in view mode: a tap never focuses the textarea", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `mtterm-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await page.setViewportSize(MOBILE_VIEWPORT);
		await pairAndOpenWorkspace(page, name);
		await openOneTerminal(page, fake);

		await page.getByTestId("code-terminal").locator(".xterm").click();
		await expect(xtermTextarea(page)).not.toBeFocused();
		const bar = page.getByRole("toolbar", { name: "Terminal keys" });
		await expect(bar).toBeVisible();
		// Wrapped, not a scrolling strip: the first and last keys are both on screen.
		await expect(bar.getByRole("button", { name: "Escape" })).toBeInViewport({ ratio: 1 });
		await expect(bar.getByRole("button", { name: "Type" })).toBeInViewport({ ratio: 1 });
		await expect(bar.getByRole("button", { name: "Increase font size" })).toBeInViewport({
			ratio: 1,
		});
	});

	test("Type focuses the textarea; Done returns to view mode; the bar stays", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `mtterm-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await page.setViewportSize(MOBILE_VIEWPORT);
		await pairAndOpenWorkspace(page, name);
		await openOneTerminal(page, fake);

		await page.getByRole("button", { name: "Type" }).click();
		await expect(xtermTextarea(page)).toBeFocused();
		const bar = page.getByRole("toolbar", { name: "Terminal keys" });
		await expect(bar).toBeVisible();

		await bar.getByRole("button", { name: "Done" }).click();
		await expect(xtermTextarea(page)).not.toBeFocused();
		await expect(bar).toBeVisible();
		await expect(bar.getByRole("button", { name: "Type" })).toBeVisible();
	});

	test("Esc and Ctrl+C reach the machine as the right bytes", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `mtterm-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await page.setViewportSize(MOBILE_VIEWPORT);
		await pairAndOpenWorkspace(page, name);
		const terminalId = await openOneTerminal(page, fake);

		await page.getByRole("button", { name: "Type" }).click();
		const bar = page.getByRole("toolbar", { name: "Terminal keys" });

		await bar.getByRole("button", { name: "Escape" }).click();
		await expect
			.poll(() => fake?.model.terminals.get(terminalId)?.history.toString("latin1") ?? "")
			.toContain("\x1b");

		await bar.getByRole("button", { name: "Send Ctrl+C" }).click();
		await expect
			.poll(() => fake?.model.terminals.get(terminalId)?.history.toString("latin1") ?? "")
			.toContain("\x03");
	});

	test("in view mode the keys still work, without raising the keyboard", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `mtterm-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await page.setViewportSize(MOBILE_VIEWPORT);
		await pairAndOpenWorkspace(page, name);
		const terminalId = await openOneTerminal(page, fake);

		const bar = page.getByRole("toolbar", { name: "Terminal keys" });
		await bar.getByRole("button", { name: "Arrow up" }).click();
		await expect
			.poll(() => {
				const history = fake?.model.terminals.get(terminalId)?.history.toString("latin1") ?? "";
				return history.includes("\x1b[A") || history.includes("\x1bOA");
			})
			.toBe(true);
		await expect(xtermTextarea(page)).not.toBeFocused();
	});

	test("sticky Ctrl applies to one key only", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `mtterm-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await page.setViewportSize(MOBILE_VIEWPORT);
		await pairAndOpenWorkspace(page, name);
		const terminalId = await openOneTerminal(page, fake);

		await page.getByRole("button", { name: "Type" }).click();
		const bar = page.getByRole("toolbar", { name: "Terminal keys" });
		const ctrl = bar.getByRole("button", { name: "Control" });
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");

		await ctrl.click();
		await expect(ctrl).toHaveAttribute("aria-pressed", "true");
		await page.keyboard.type("c");
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");

		await page.keyboard.type("c");

		await expect
			.poll(() => {
				const history = fake?.model.terminals.get(terminalId)?.history ?? Buffer.alloc(0);
				return [...history].filter((b) => b === "c".charCodeAt(0)).length;
			})
			.toBe(1);
		await expect
			.poll(() => {
				const history = fake?.model.terminals.get(terminalId)?.history ?? Buffer.alloc(0);
				return [...history].filter((b) => b === 0x03).length;
			})
			.toBe(1);
	});

	test("an arrow sends the right byte sequence", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `mtterm-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await page.setViewportSize(MOBILE_VIEWPORT);
		await pairAndOpenWorkspace(page, name);
		const terminalId = await openOneTerminal(page, fake);

		await page.getByRole("button", { name: "Type" }).click();
		const bar = page.getByRole("toolbar", { name: "Terminal keys" });
		await bar.getByRole("button", { name: "Arrow up" }).click();

		await expect
			.poll(() => fake?.model.terminals.get(terminalId)?.history.toString("latin1") ?? "")
			.toContain("\x1b[A");
	});

	test("A+ increases the font size, refits and resizes", async ({ page, db, session }) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `mtterm-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

		await page.setViewportSize(MOBILE_VIEWPORT);
		await pairAndOpenWorkspace(page, name);

		// Same signal as code-terminal.spec.ts's own resize case: a real
		// `terminal.resize` op landing over the wire, captured as it arrives
		// (overriding, not just observing, the default handler — see `onOp`).
		// The terminal's own fit-on-mount resize never reaches this (`onResize`
		// is wired up after that first `fitAddon.fit()` call, same as the
		// existing desktop resize spec relies on), so the first op this ever
		// sees is the one the font-size change below causes.
		const resizeArgs: Array<{ cols: number; rows: number }> = [];
		fake.onOp("terminal.resize", (args: { cols: number; rows: number }) => {
			resizeArgs.push(args);
			return { applied: true };
		});

		// `terminal.open` requested 80 columns — the machine's own idea of
		// this terminal's width until a resize op says otherwise.
		const beforeCols = 80;

		await openOneTerminal(page, fake);
		await page.getByRole("button", { name: "Type" }).click();
		const bar = page.getByRole("toolbar", { name: "Terminal keys" });
		await bar.getByRole("button", { name: "Increase font size" }).click();

		// A bigger font fits fewer columns in the same fixed-width sheet —
		// the fit addon's refit, landing over the wire as a fresh resize.
		await expect.poll(() => resizeArgs.length, { timeout: 10_000 }).toBeGreaterThan(0);
		expect(resizeArgs.at(-1)?.cols ?? 0).toBeLessThan(beforeCols);
	});
});

test.describe("the terminal on desktop", () => {
	let fake: FakeMachine | null = null;

	test.afterEach(() => {
		fake?.close();
		fake = null;
	});

	test("has no bar and no Type button — typing goes straight to xterm as before", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `dtterm-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);

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
		await page.getByRole("button", { name: "Create agent" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		await openOneTerminal(page, fake);

		await expect(page.getByRole("button", { name: "Type" })).toHaveCount(0);
		await expect(page.getByRole("toolbar", { name: "Terminal keys" })).toHaveCount(0);

		const term = page.getByTestId("code-terminal");
		await term.click();
		const marker = `desktop-${randomUUID().slice(0, 8)}`;
		await page.keyboard.type(marker);
		await expect(term).toContainText(marker, { timeout: 10_000 });
	});
});
