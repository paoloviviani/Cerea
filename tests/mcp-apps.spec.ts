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

const lastAssistant = (page: Page) => page.locator('[data-message-role="assistant"]').last();

async function seedAppsConnector(db: Db, sessionId: string, opts: { appsAllowed?: boolean } = {}) {
	const userId = await seedUser(db, sessionId, `e2e-${randomUUID()}`);
	// Ask: a call the page starts must raise the same card a model's call does.
	await db.collection("settings").updateOne({ userId }, { $set: { toolApprovalPolicy: "manual" } });
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
			tool("plain", "A tool with no app."),
		],
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	await db.collection("connectorModes").insertOne({
		_id: new ObjectId(),
		key: `connector:${id}`,
		mode: "on",
		alwaysLoaded: true,
		...(opts.appsAllowed === false ? { appsAllowed: false } : {}),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
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

	test("a tool call from the page asks for approval like a model's call", async ({
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
		// The card names the tool the page wants, and nothing ran before the answer.
		const card = page.getByText("echo_app").last();
		await expect(card).toBeVisible({ timeout: 20_000 });
		expect((await control.calls()).filter((c) => c.name === "echo_app")).toHaveLength(0);

		await page.getByRole("button", { name: "Allow once" }).last().click();
		await expect(APP.inside(page).locator("#call-result")).toContainText(
			"result:app-echo:from-app",
			{
				timeout: 20_000,
			}
		);
		expect((await control.calls()).filter((c) => c.name === "echo_app")).toHaveLength(1);
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
		await APP.inside(page).locator("#call-tool").click();
		await expect(page.getByText("echo_app").last()).toBeVisible({ timeout: 20_000 });
		await page.getByRole("button", { name: "Deny" }).last().click();
		await expect(APP.inside(page).locator("#call-result")).toContainText("error:", {
			timeout: 20_000,
		});
		expect((await control.calls()).filter((c) => c.name === "echo_app")).toHaveLength(0);
	});

	test("a message from the page lands in the chat", async ({ page, db, session, mockOpenAI }) => {
		await seedAppsConnector(db, session.sessionId);
		await runTool(page, mockOpenAI, "show_probe");
		await allowModelCall(page);
		await expect(APP.frame(page)).toBeVisible({ timeout: 45_000 });
		await APP.inside(page).locator("#send-message").click();
		await expect(page.getByText("hello from the app")).toBeVisible({ timeout: 20_000 });
	});

	test("sandbox escapes fail: cookie, parent, top navigation, storage, undeclared domain", async ({
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
		for (const name of [
			"cookie",
			"parentDocument",
			"topNavigation",
			"fetchUndeclared",
			"localStorage",
		]) {
			expect(results[name], `${name} was not probed`).toBeDefined();
			expect(results[name].ok, `${name} succeeded: ${results[name].detail}`).toBe(false);
		}
		// The CSP stopped the request before it left: the fixture never saw it.
		expect(await control.escapePings()).toBe(0);
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
