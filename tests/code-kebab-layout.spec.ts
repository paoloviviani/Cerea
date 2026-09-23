/**
 * The /code panel's kebabs, hermetically: the /code endpoints are stubbed at
 * the network layer, so the client code paths driving the sidebar tree are
 * the real ones (the pills/dialogs specs' pattern).
 *
 * What is pinned here: the workspace row's "start a session" + and the
 * agent row's presence dot never move when the row's kebab is revealed on
 * hover — the kebab's 24px slot is reserved at all times, only its opacity
 * toggles — and the same holds for the chat list's own kebab. All three
 * kebabs (workspace, session, chat) draw the same horizontal three-dot
 * glyph, not the vertical one the workspace/session rows used to carry. And
 * a device that already has a workspace still gets a + to add another one.
 */
import { test, expect } from "./fixtures";
import type { Locator, Page } from "playwright/test";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS1 = "ws_e2e_one";
const WS2 = "ws_e2e_two";
const AGENT = "agent_e2e_one";
const WS1_NAME = "e2e-workspace-one";
const WS2_NAME = "e2e-workspace-two";
const AGENT_TITLE = "e2e-agent-one";

const superjsonBody = (data: unknown) => superjson.stringify(data);

async function stubCodePanel(page: Page) {
	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ devices: [{ id: DEVICE, name: "e2e box", status: "paired" }] }),
		})
	);
	await page.route("**/api/v2/code/v1/workspaces?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				workspaces: [
					{ id: WS1, name: WS1_NAME, path: "/repo/one" },
					{ id: WS2, name: WS2_NAME, path: "/repo/two" },
				],
			}),
		})
	);
	await page.route("**/api/v2/code/v1/agents?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				agents: [
					{
						id: AGENT,
						title: AGENT_TITLE,
						provider: "opencode",
						state: "running",
						cwd: "/repo/one",
						workspaceId: WS1,
						modeId: "plan",
						modelId: "pystino/coder-large",
					},
				],
			}),
		})
	);
}

async function openAgentsPanel(page: Page) {
	await page.goto(`/code?device=${DEVICE}`);
	await page.getByRole("button", { name: "Open Agents panel" }).click();
}

/** A bounding box or a clear failure — the null return is never useful here. */
async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error(`No bounding box for ${locator}`);
	return box;
}

/** Same position and size, within a hairline of subpixel rounding. */
function expectSameBox(
	after: { x: number; y: number; width: number; height: number },
	before: { x: number; y: number; width: number; height: number }
) {
	expect(after.x).toBeCloseTo(before.x, 1);
	expect(after.y).toBeCloseTo(before.y, 1);
	expect(after.width).toBeCloseTo(before.width, 1);
	expect(after.height).toBeCloseTo(before.height, 1);
}

async function opacityOf(locator: Locator): Promise<number> {
	return locator.evaluate((el) => Number(getComputedStyle(el).opacity));
}

/** The trigger's glyph, as its three dot centers — geometry, not the icon
 * library's identity, is what "horizontal" means here. */
async function dotCenters(locator: Locator): Promise<Array<{ cx: number; cy: number }>> {
	return locator.evaluate((el) => {
		const svg = el.querySelector("svg");
		if (!svg) throw new Error("kebab trigger has no svg");
		return Array.from(svg.querySelectorAll("circle")).map((c) => ({
			cx: Number(c.getAttribute("cx")),
			cy: Number(c.getAttribute("cy")),
		}));
	});
}

function expectHorizontalDots(dots: Array<{ cx: number; cy: number }>) {
	expect(dots).toHaveLength(3);
	// Three distinct x positions, one shared y: a row, not a column.
	expect(new Set(dots.map((d) => d.cy)).size).toBe(1);
	expect(new Set(dots.map((d) => d.cx)).size).toBe(3);
}

test.beforeEach(async ({ page }) => {
	await stubCodePanel(page);
	await page.setViewportSize({ width: 1280, height: 800 });
});

/** The workspace/session row is the nearest ancestor `.group` div that
 * carries the row's own text — hover and `group-hover:` styling key off
 * this element, and scoping locators to it disambiguates rows sharing the
 * same button titles (two workspaces both offer "Start a coding session"). */
function rowOf(page: Page, text: string): Locator {
	return page.locator("div.group").filter({ hasText: text });
}

test("hovering the workspace row moves neither its + nor its kebab, which stays reserved-width while hidden", async ({
	page,
}) => {
	await openAgentsPanel(page);

	const wsRow = rowOf(page, WS1_NAME);
	await expect(wsRow).toBeVisible();

	const startSession = wsRow.locator('button[title="Start a coding session in this workspace"]');
	const kebab = wsRow.getByRole("button", { name: "Workspace actions" });

	const startBefore = await boxOf(startSession);
	const kebabBefore = await boxOf(kebab);
	// Reserved space: the trigger has real width even while invisible.
	expect(kebabBefore.width).toBeGreaterThan(0);
	expect(await opacityOf(kebab)).toBeLessThan(0.5);

	await wsRow.hover();

	const startAfter = await boxOf(startSession);
	const kebabAfter = await boxOf(kebab);
	expect(await opacityOf(kebab)).toBeGreaterThan(0.5);

	// Nothing moved: the + stayed put, and the kebab occupied the exact
	// same box before and after it became visible.
	expectSameBox(startAfter, startBefore);
	expectSameBox(kebabAfter, kebabBefore);
});

test("hovering the agent row moves neither its presence dot nor its kebab, which stays reserved-width while hidden", async ({
	page,
}) => {
	await openAgentsPanel(page);

	const agentRow = rowOf(page, AGENT_TITLE);
	await expect(agentRow).toBeVisible();

	const dot = agentRow.locator('span[title="running"]');
	const kebab = agentRow.getByRole("button", { name: "Session actions" });

	const dotBefore = await boxOf(dot);
	const kebabBefore = await boxOf(kebab);
	expect(kebabBefore.width).toBeGreaterThan(0);
	expect(await opacityOf(kebab)).toBeLessThan(0.5);

	await agentRow.hover();

	const dotAfter = await boxOf(dot);
	const kebabAfter = await boxOf(kebab);
	expect(await opacityOf(kebab)).toBeGreaterThan(0.5);

	expectSameBox(dotAfter, dotBefore);
	expectSameBox(kebabAfter, kebabBefore);
});

test("the workspace, session and chat kebabs all draw the same horizontal glyph", async ({
	page,
	seedConversation,
}) => {
	await seedConversation({ title: "a chat row" });

	await openAgentsPanel(page);
	expectHorizontalDots(
		await dotCenters(rowOf(page, WS1_NAME).getByRole("button", { name: "Workspace actions" }))
	);
	expectHorizontalDots(
		await dotCenters(rowOf(page, AGENT_TITLE).getByRole("button", { name: "Session actions" }))
	);

	// Switch back to the chat list — the panel switch at the foot of the
	// sidebar, not a fresh navigation, so the same page is reused.
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	await expect(page.getByText("a chat row")).toBeVisible();
	expectHorizontalDots(
		await dotCenters(page.getByRole("button", { name: "Conversation actions" }))
	);
});

test("the + next to Pair opens the workspace dialog, even when the device already has a workspace", async ({
	page,
}) => {
	await openAgentsPanel(page);
	await expect(page.getByText(WS1_NAME, { exact: true })).toBeVisible();
	await expect(page.getByText(WS2_NAME, { exact: true })).toBeVisible();

	await page.locator('button[title="Add a workspace to this device"]').click();

	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText("Add a workspace")).toBeVisible();
	await expect(dialog.getByLabel("Directory on the machine")).toBeVisible();
});
