/**
 * MCP Apps (#44): a tool linked to a `ui://` page renders it in the tool card, in a sandbox.
 *
 * Driven against `tests/mock-apps-mcp.ts`. The PAIRING: this file is written against the
 * rendering of `feat/mcp-apps` (PR A); the fixture, the admin switch and the galopin relay are
 * this branch's (PR B).
 *
 *  - Runs on this branch alone ........ the "apps off" and "text result" specs: no app is
 *                                        rendered, so they hold with or without A.
 *  - NEEDS PR A (`@needs-apps-render`) . everything that expects the iframe. Their selectors are
 *                                        the one `APP` block below: if A named its test ids
 *                                        differently, change that block and nothing else.
 *
 * The model is the scripted mock: it calls one tool, then answers with text.
 */
import { randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import type { Page } from "playwright/test";
import {
	test,
	expect,
	E2E_APP_BASE,
	MOCK_APPS_MCP_URL,
	mockAppsMcpControl,
	waitForHydration,
} from "./fixtures";
import { PROBES_MUST_FAIL } from "./mock-apps-mcp";
import { seedUser } from "./machineHarness";

/** What this spec needs from A's rendering (its test ids). The single place to reconcile. */
const APP = {
	/** The tool card's container for an app. */
	card: (page: Page) => page.locator('[data-testid="mcp-app"]').last(),
	/** The sandboxed iframe inside it. */
	frame: (page: Page) => page.locator('[data-testid="mcp-app"] iframe').last(),
	/** The page inside that iframe. */
	inside: (page: Page) => page.frameLocator('[data-testid="mcp-app"] iframe').last(),
};

/**
 * The rendering specs run only once the rendering is on main: they fail on a tree without it.
 * PR A's merge sets `E2E_APPS_RENDER=1` in CI (or removes this guard).
 */
const RENDERED = process.env.E2E_APPS_RENDER === "1";

/** A value the test needs: fails with a clear message rather than a non-null assertion. */
function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("expected a value");
	return value;
}

const lastAssistant = (page: Page) => page.locator('[data-message-role="assistant"]').last();

async function seedAppsConnector(db: Db, sessionId: string, opts: { appsAllowed?: boolean } = {}) {
	const userId = await seedUser(db, sessionId, `e2e-${randomUUID()}`);
	// Ask: a call the page starts must raise the same card a model's call does.
	await db.collection("settings").updateOne({ userId }, { $set: { toolApprovalPolicy: "manual" } });
	// The database lives across the tests of a run, and tool names are shared across connectors: an
	// earlier test's connector (with its own switch) would own the same tool names and be the one a
	// call resolves to. A unique name does not help; the earlier rows have to go.
	const stale = await db.collection("mcpConnectors").find({ name: "Apps" }).toArray();
	await db.collection("mcpConnectors").deleteMany({ name: "Apps" });
	await db.collection("connectorModes").deleteMany({
		key: { $in: stale.map((row) => `connector:${row._id}`) },
	});
	const id = new ObjectId();
	const tool = (name: string, description: string, ui?: Record<string, unknown>) => ({
		name,
		description,
		...(ui ? { _meta: { ui } } : {}),
	});
	await db.collection("mcpConnectors").insertOne({
		_id: id,
		userId: new ObjectId(),
		scope: "deployment",
		name: "Apps",
		url: MOCK_APPS_MCP_URL,
		auth: "none",
		probedAt: new Date(),
		tools: [
			tool("show_probe", "Shows the probe app.", { resourceUri: "ui://mock-apps/probe.html" }),
			tool("show_time", "Shows the time app.", { resourceUri: "ui://mock-apps/time.html" }),
			// Model-visible too: a page's call to it asks first.
			tool("echo_shared", "Echoes text; the model can call it too.", {
				resourceUri: "ui://mock-apps/probe.html",
			}),
			tool("show_broken", "Shows a page that throws on load.", {
				resourceUri: "ui://mock-apps/broken.html",
			}),
			tool("plain", "A tool with no app."),
			// Only the page may call it: the model is never offered it.
			tool("echo_app", "Echoes text; only the app page calls it.", {
				resourceUri: "ui://mock-apps/probe.html",
				visibility: ["app"],
			}),
		],
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	// Upsert and always explicit: a database kept between local runs may hold a row for this key.
	await db.collection("connectorModes").updateOne(
		{ key: `connector:${id}` },
		{
			$set: {
				mode: "on",
				alwaysLoaded: true,
				appsAllowed: opts.appsAllowed !== false,
				updatedAt: new Date(),
			},
			$setOnInsert: { _id: new ObjectId(), createdAt: new Date() },
		},
		{ upsert: true }
	);
	return { userId, connectorId: id };
}

async function runTool(
	page: Page,
	mockOpenAI: { setDefaultScenario(s: Record<string, unknown>): Promise<void> },
	name: string,
	args: Record<string, unknown> = {}
) {
	await mockOpenAI.setDefaultScenario({
		toolCalls: [{ id: `call_${name}`, name, arguments: JSON.stringify(args) }],
		content: ["Done ", "showing."],
		chunkDelayMs: 10,
		finishReason: "stop",
	});
	await page.goto(`${E2E_APP_BASE}/`);
	await waitForHydration(page);
	await page.getByPlaceholder("Ask anything").fill(`run ${name}`);
	await page.getByRole("button", { name: "Send message" }).click();
	await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
}

/** Calls through the approval gate must be answered; the model's own call asks first. */
async function allowModelCall(page: Page) {
	await lastAssistant(page).getByRole("button", { name: "Allow once" }).click();
}

test.describe("MCP Apps: without a rendered app (holds with or without PR A)", () => {
	test("a connector whose apps are switched off shows only the tool's text result", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await seedAppsConnector(db, session.sessionId, { appsAllowed: false });
		await runTool(page, mockOpenAI, "show_probe", { label: "off" });
		await allowModelCall(page);
		await expect(lastAssistant(page)).toContainText("Done showing.", { timeout: 45_000 });
		await expect(page.locator('[data-testid="mcp-app"]')).toHaveCount(0);
		await expect(page.locator("iframe[sandbox]")).toHaveCount(0);
	});

	test("a tool with no app behaves as before", async ({ page, db, session, mockOpenAI }) => {
		await seedAppsConnector(db, session.sessionId);
		await runTool(page, mockOpenAI, "plain");
		await allowModelCall(page);
		await expect(lastAssistant(page)).toContainText("Done showing.", { timeout: 45_000 });
		await expect(page.locator('[data-testid="mcp-app"]')).toHaveCount(0);
	});
});

test.describe("MCP Apps: rendering @needs-apps-render", () => {
	test.skip(!RENDERED, "needs the MCP Apps rendering (feat/mcp-apps): set E2E_APPS_RENDER=1");
	test.beforeEach(async ({ request }) => {
		await mockAppsMcpControl(request).reset();
	});

	test("the app renders in the tool card, sandboxed, and gets the tool input", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		await runTool(page, mockOpenAI, "show_probe", { label: "hello" });
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		// A sandbox without `allow-same-origin`: the page is an opaque origin.
		const sandbox = (await APP.frame(page).getAttribute("sandbox")) ?? "";
		expect(sandbox).toContain("allow-scripts");
		expect(sandbox).not.toContain("allow-same-origin");
		expect(sandbox).not.toContain("allow-top-navigation");
		await expect(APP.inside(page).locator("#input")).toContainText('input:{"label":"hello"}');
	});

	test("apps on is the control for apps off: the same turn renders the app, and the model never sees the app-only tool", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await seedAppsConnector(db, session.sessionId, { appsAllowed: true });
		await runTool(page, mockOpenAI, "show_probe", { label: "on" });
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		const offered = ((await mockOpenAI.requests()) as { body: { tools?: unknown } }[]).flatMap(
			(r) => JSON.stringify(r.body.tools ?? [])
		);
		expect(offered.join("")).toContain("show_probe");
		expect(offered.join("")).not.toContain("echo_app");
	});

	test("full screen is a real full-window layer above the app, and the page does not reload", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		await page.setViewportSize({ width: 1280, height: 1000 });
		await runTool(page, mockOpenAI, "show_probe");
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		const inside = APP.inside(page);
		await expect(inside.locator("#load-marker")).toContainText("marker:");
		const marker = await inside.locator("#load-marker").textContent();
		const sidebar = page.locator("nav.app-sidebar:not(.fixed)");
		await expect(sidebar).toBeVisible();
		await expect(inside.locator("#display-mode")).toHaveText("display:inline");

		const expand = page.getByRole("button", { name: "Full screen" }).last();
		await expand.click();
		const layer = page.locator('[data-testid="mcp-app"][data-display-mode="fullscreen"]');
		await expect(layer).toBeVisible();
		await expect(inside.locator("#display-mode")).toHaveText("display:fullscreen");
		const viewport = must(page.viewportSize());
		const box = must(await layer.boundingBox());
		expect(box).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
		// A point over the sidebar, and one over the composer: both belong to the layer.
		const probes = await page.evaluate(() => {
			const layerEl = document.querySelector(
				'[data-testid="mcp-app"][data-display-mode="fullscreen"]'
			);
			const nav = document.querySelector("nav.app-sidebar:not(.fixed)")?.getBoundingClientRect();
			if (!layerEl || !nav) return [false];
			const hit = (x: number, y: number) => layerEl.contains(document.elementFromPoint(x, y));
			return [
				hit(nav.left + 20, nav.top + 20),
				hit(nav.left + 20, nav.top + nav.height / 2),
				hit(window.innerWidth / 2, window.innerHeight - 20),
			];
		});
		expect(probes).toEqual([true, true, true]);
		// The frame fills the layer below the header bar.
		const frameBox = must(await APP.frame(page).boundingBox());
		expect(frameBox.width).toBe(viewport.width);
		// Not the inline limit: the frame is as tall as the layer allows, below the header bar (and the
		// probe page's own diagnostics row, which its refused fetches raise).
		expect(frameBox.y).toBeGreaterThan(20);
		expect(frameBox.y + frameBox.height).toBeLessThanOrEqual(viewport.height);
		expect(frameBox.height).toBeGreaterThan(720);
		await expect(page.getByRole("button", { name: "Close full screen" })).toBeVisible();

		// Escape leaves, tells the page, and gives the focus back to the expand button.
		await page.keyboard.press("Escape");
		await expect(layer).toHaveCount(0);
		await expect(inside.locator("#display-mode")).toHaveText("display:inline");
		await expect(expand).toBeFocused();

		// The page asks (its "Edit"), our close button leaves.
		await inside.locator("#request-fullscreen").click();
		await expect(layer).toBeVisible();
		await expect(inside.locator("#display-mode")).toHaveText("display:fullscreen");
		await page.getByRole("button", { name: "Close full screen" }).click();
		await expect(layer).toHaveCount(0);
		await expect(inside.locator("#display-mode")).toHaveText("display:inline");

		// The same document throughout: a reload would have drawn a new marker and closed the bridge.
		await expect(inside.locator("#load-marker")).toHaveText(must(marker));
		await expect(page.locator('[data-testid="mcp-app-closed"]')).toHaveCount(0);
	});

	test("full screen covers a phone screen and its close button is reachable", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		await page.setViewportSize({ width: 390, height: 844 });
		await runTool(page, mockOpenAI, "show_probe");
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		await page.getByRole("button", { name: "Full screen" }).last().click();
		const layer = page.locator('[data-testid="mcp-app"][data-display-mode="fullscreen"]');
		await expect(layer).toBeVisible();
		const box = must(await layer.boundingBox());
		expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
		const close = page.getByRole("button", { name: "Close full screen" });
		const closeBox = must(await close.boundingBox());
		expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(390);
		expect(closeBox.y).toBeGreaterThanOrEqual(0);
		const hit = await page.evaluate(
			([x, y]) => {
				const el = document.elementFromPoint(x, y);
				return Boolean(el?.closest('button[aria-label="Close full screen"]'));
			},
			[closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2]
		);
		expect(hit).toBe(true);
		await close.click();
		await expect(layer).toHaveCount(0);
	});

	test("a page that fails shows its errors behind a Show details link, and the report reaches the server", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		const reports: string[] = [];
		page.on("request", (req) => {
			if (req.url().endsWith("/mcp-app/diag")) reports.push(req.postData() ?? "");
		});
		await runTool(page, mockOpenAI, "show_broken");
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		const link = page.getByRole("button", { name: "Show details" }).last();
		await expect(link).toBeVisible({ timeout: 20_000 });
		await link.click();
		const details = page.locator('[data-testid="mcp-app-details"]').last();
		await expect(details).toContainText("boom-on-load");
		// The refused fetch is a policy violation, recorded as such.
		await expect(details).toContainText("[csp]");
		await expect(details).toContainText("connect-src");
		await expect(details.getByRole("button", { name: "Copy" })).toBeVisible();
		await expect.poll(() => reports.length, { timeout: 10_000 }).toBeGreaterThan(0);
		expect(reports[0]).toContain("boom-on-load");
		expect(reports[0]).toContain("connector:");
		// Reload view mounts the frame again: the same errors come back, and the panel starts closed.
		await details.getByRole("button", { name: "Reload view" }).click();
		await expect(page.locator('[data-testid="mcp-app-details"]')).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Show details" }).last()).toBeVisible({
			timeout: 20_000,
		});
	});

	test("a message from another window is not taken for the page's diagnostics", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		await runTool(page, mockOpenAI, "show_time");
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		await expect(APP.inside(page).locator("#get-time-btn")).toBeVisible({ timeout: 20_000 });
		await page.evaluate(() => {
			window.postMessage(
				{ cereaDiag: { kind: "error", message: "forged", source: "", line: 1 } },
				"*"
			);
		});
		await page.waitForTimeout(500);
		await expect(page.getByRole("button", { name: "Show details" })).toHaveCount(0);
	});

	test("the app view shows with its run folded into a summary, and folding never reloads it", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		await mockOpenAI.setDefaultScenario({
			toolCalls: [
				{ id: "call_plain", name: "plain", arguments: "{}" },
				{ id: "call_probe", name: "show_probe", arguments: "{}" },
			],
			content: ["Done ", "showing."],
			chunkDelayMs: 10,
			finishReason: "stop",
		});
		await page.goto(`${E2E_APP_BASE}/`);
		await waitForHydration(page);
		await page.getByPlaceholder("Ask anything").fill("run both");
		await page.getByRole("button", { name: "Send message" }).click();
		await page.waitForURL(/\/conversation\/[a-f0-9]{24}/);
		for (let i = 0; i < 2; i += 1) {
			await page.getByRole("button", { name: "Allow once" }).first().click({ timeout: 45_000 });
		}
		// No click on any row: the view is there.
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		const inside = APP.inside(page);
		await expect(inside.locator("#load-marker")).toContainText("marker:");
		const marker = await inside.locator("#load-marker").textContent();
		const summaryToggle = (name: "Expand" | "Collapse") =>
			lastAssistant(page).getByRole("button", { name, exact: true }).first();
		await summaryToggle("Expand").click();
		await expect(APP.frame(page)).toHaveCount(1);
		await summaryToggle("Collapse").click();
		await expect(APP.frame(page)).toBeVisible();
		await expect(inside.locator("#load-marker")).toHaveText(must(marker));
		await expect(page.locator('[data-testid="mcp-app-closed"]')).toHaveCount(0);
	});

	test("a page-only tool runs from the page with no approval card, under Ask", async ({
		page,
		db,
		session,
		mockOpenAI,
		request,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		const control = mockAppsMcpControl(request);
		await runTool(page, mockOpenAI, "show_probe");
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		await APP.inside(page).locator("#call-tool").click();
		await expect(APP.inside(page).locator("#call-result")).toContainText(
			"result:app-echo:from-app",
			{ timeout: 20_000 }
		);
		await expect(page.locator('[data-testid="mcp-app-approval"]')).toHaveCount(0);
		expect((await control.calls()).filter((c) => c.name === "echo_app")).toHaveLength(1);
	});

	test("a call from the page to a tool the model can also use asks for approval like a model's call", async ({
		page,
		db,
		session,
		mockOpenAI,
		request,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		const control = mockAppsMcpControl(request);
		await runTool(page, mockOpenAI, "show_probe");
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });

		await APP.inside(page).locator("#call-shared").click();
		// The card names the tool the page wants, and nothing ran before the answer.
		const card = page.getByText("echo_shared").last();
		await expect(card).toBeVisible({ timeout: 20_000 });
		expect((await control.calls()).filter((c) => c.name === "echo_shared")).toHaveLength(0);

		await page.getByRole("button", { name: "Allow once" }).last().click();
		await expect(APP.inside(page).locator("#call-result")).toContainText(
			"result:app-echo:from-app",
			{
				timeout: 20_000,
			}
		);
		expect((await control.calls()).filter((c) => c.name === "echo_shared")).toHaveLength(1);
	});

	test("denying a call from the page returns an error to the page and runs nothing", async ({
		page,
		db,
		session,
		mockOpenAI,
		request,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		const control = mockAppsMcpControl(request);
		await runTool(page, mockOpenAI, "show_probe");
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		await APP.inside(page).locator("#call-shared").click();
		await expect(page.getByText("echo_shared").last()).toBeVisible({ timeout: 20_000 });
		await page.getByRole("button", { name: "Deny" }).last().click();
		// A denial is a tool result with isError, not a protocol error: the page prints "result:".
		await expect(APP.inside(page).locator("#call-result")).toContainText("result:The user denied", {
			timeout: 20_000,
		});
		expect((await control.calls()).filter((c) => c.name === "echo_shared")).toHaveLength(0);
	});

	test("a message from the page is a suggestion above the composer, inserted only by a click", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		await runTool(page, mockOpenAI, "show_probe");
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		await APP.inside(page).locator("#send-message").click();
		const chip = page.locator('[data-testid="app-suggestion"]');
		await expect(chip).toContainText("hello from the app", { timeout: 20_000 });
		await expect(chip).toContainText("suggests a message");
		// Nothing was written into the composer, and nothing was sent.
		const composer = page.locator("textarea[data-testid='chat-input']");
		await expect(composer).toHaveValue("");
		await chip.getByRole("button", { name: "Insert" }).click();
		await expect(composer).toHaveValue("hello from the app");
		await expect(chip).toHaveCount(0);
	});

	test("sandbox escapes fail: cookie, origin, parent, top navigation, storage, undeclared domain, image and beacon", async ({
		page,
		db,
		session,
		mockOpenAI,
		request,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		const control = mockAppsMcpControl(request);
		await runTool(page, mockOpenAI, "show_probe");
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		await expect(APP.inside(page).locator("body[data-done='1']")).toBeAttached({
			timeout: 20_000,
		});
		const results = JSON.parse(
			(await APP.inside(page).locator("#probe-results").textContent()) ?? "{}"
		) as Record<string, { ok: boolean; detail: string }>;
		for (const name of PROBES_MUST_FAIL) {
			// `sendBeacon` answers true when it only queued the request; whether it left is the
			// fixture's own count below, which is the proof.
			if (name === "beacon") {
				expect(results[name], "beacon was not probed").toBeDefined();
				continue;
			}
			expect(results[name], `${name} was not probed`).toBeDefined();
			expect(results[name].ok, `${name} succeeded: ${results[name].detail}`).toBe(false);
		}
		// The CSP stopped the request before it left: the fixture never saw it.
		await page.waitForTimeout(1000);
		await expect.poll(() => control.escapePings(), { timeout: 2000 }).toBe(0);
		// And the chat itself did not navigate away.
		expect(page.url()).toMatch(/\/conversation\//);
	});

	test("a reload keeps the app from its snapshot, without fetching the page again", async ({
		page,
		db,
		session,
		mockOpenAI,
		request,
	}) => {
		await seedAppsConnector(db, session.sessionId);
		const control = mockAppsMcpControl(request);
		await runTool(page, mockOpenAI, "show_time");
		await allowModelCall(page);
		await expect(APP.inside(page).locator("#server-time")).not.toHaveText("Loading...", {
			timeout: 45_000,
		});
		await expect(lastAssistant(page)).toContainText("Done showing.", { timeout: 45_000 });
		const reads = (await control.reads()).length;
		expect(reads).toBeGreaterThan(0);

		await page.reload();
		await waitForHydration(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 20_000 });
		await expect(APP.inside(page).locator("#get-time-btn")).toBeVisible();
		expect((await control.reads()).length).toBe(reads);
	});

	test("switching the connector's apps off removes the app on the next turn", async ({
		page,
		db,
		session,
		mockOpenAI,
	}) => {
		const { connectorId } = await seedAppsConnector(db, session.sessionId);
		await runTool(page, mockOpenAI, "show_probe");
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });

		await db
			.collection("connectorModes")
			.updateOne({ key: `connector:${connectorId}` }, { $set: { appsAllowed: false } });
		await runTool(page, mockOpenAI, "show_probe");
		await allowModelCall(page);
		await expect(lastAssistant(page)).toContainText("Done showing.", { timeout: 45_000 });
		await expect(page.locator('[data-testid="mcp-app"]')).toHaveCount(0);
	});
});
