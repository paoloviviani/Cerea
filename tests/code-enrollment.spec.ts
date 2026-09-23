/**
 * Enrollment liveness: detecting a dead machine grant before the first
 * send, and keeping the sidebar's device/agent lists live without a reload.
 *
 * The daemon's stored IdP tokens (minted by `enroll enroll` on the paired
 * machine) can go dead between sessions; today the person only learns this
 * from a 502 System Error after they type a message. This suite pins:
 *
 * - opening a device/agent whose enrollment the daemon reports as expired
 *   (an `invalid_grant`-class refusal from `listAvailableProviders`, this
 *   deployment's cheapest proxy for "the stored credentials still work" —
 *   see `checkEnrollment` in `codeApi.ts`) turns the sidebar's paired pill
 *   into a clickable "re-enroll" control and disables the composer's send,
 *   before any message is sent;
 * - a merely unreachable daemon (a network failure, no `invalid_grant`
 *   anywhere in it) must never be reported the same way — the pill stays
 *   "paired";
 * - a device paired, or an agent created, from elsewhere (another tab, the
 *   daemon's own CLI) appears in the tree once the tab's quiet poll or its
 *   focus refetch runs, with no page reload.
 */
import { test, expect } from "./fixtures";
import type { Page } from "playwright/test";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const DEVICE2 = "srv_e2e_device_2";
const WS = "ws_e2e";
const AGENT = "agent_e2e";

const superjsonBody = (data: unknown) => superjson.stringify(data);

/** The sidebar defaults to the chat list; `CodeNavTree` only mounts once the
 * rail's own "Agents" switch is on — the same click a person makes, not a
 * URL parameter. Every assertion on the device tree needs this first. */
async function openAgentsPanel(page: Page) {
	await page.getByRole("button", { name: "Agents", exact: true }).click();
}

const AGENT_SNAPSHOT = {
	id: AGENT,
	title: "e2e agent",
	provider: "opencode",
	state: "idle",
	workspaceId: WS,
	modeId: "plan",
	modelId: "pystino/coder-large",
	cwd: "/repo",
	features: [],
};

/** The pill/panel's shared plumbing every scenario below needs: the device
 * row, its workspace, its agent's snapshot and the pills' option lists —
 * everything BUT the providers probe, which each test supplies itself. */
async function installBaseStubs(page: Page) {
	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				devices: [{ id: DEVICE, name: "e2e box", status: "paired" }],
			}),
		})
	);
	await page.route(`**/api/v2/code/v1/agents/${AGENT}?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ agent: AGENT_SNAPSHOT, features: [], cwd: AGENT_SNAPSHOT.cwd }),
		})
	);
	await page.route("**/api/v2/code/v1/workspaces?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ workspaces: [{ id: WS, name: "repo", path: "/repo" }] }),
		})
	);
	await page.route("**/api/v2/code/v1/agents?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ agents: [] }) })
	);
	await page.route("**/api/v2/code/v1/providers/opencode/modes?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ modes: [{ id: "plan", label: "Plan" }] }),
		})
	);
	await page.route("**/api/v2/code/v1/providers/opencode/models?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				models: [{ id: "pystino/coder-large", label: "Coder Large", isDefault: true }],
			}),
		})
	);
	await page.route("**/api/v2/code/v1/providers/opencode/features?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ features: [] }) })
	);
	// A settled stream: the agent view mounts, folds the snapshot's turn
	// state, and nothing more — no live turn is under test here.
	await page.route(`**/api/v2/code/agents/${AGENT}/stream?*`, (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/event-stream",
			body:
				`event: update\ndata: ${JSON.stringify({ type: "turnState", state: "done", serverNow: Date.now() })}\n\n` +
				"event: end\ndata: {}\n\n",
		})
	);
}

test.describe("an expired enrollment", () => {
	test.beforeEach(async ({ page }) => {
		await installBaseStubs(page);
		await page.route("**/api/v2/code/v1/providers?*", (route) =>
			route.fulfill({
				contentType: "application/json",
				body: superjsonBody({
					providers: [{ id: "opencode", available: false, enrollmentExpired: true }],
				}),
			})
		);
	});

	test("turns the sidebar pill into a clickable re-enroll control before any message", async ({
		page,
	}) => {
		await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);
		await openAgentsPanel(page);

		// The device's own row in the Agents panel: "paired" is gone, replaced
		// by a control naming the fix, not just the symptom.
		const reenrollPill = page.getByRole("button", { name: "re-enroll", exact: true });
		await expect(reenrollPill).toBeVisible();
		await expect(page.getByText("paired", { exact: true })).toHaveCount(0);

		// The composer refuses the send it knows is doomed — before the
		// person has typed anything, let alone pressed enter.
		await expect(page.getByText(/enrollment expired or was revoked/i)).toBeVisible();
		await page.getByPlaceholder("Follow up with the agent…").fill("are you there?");
		await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();

		// The pill opens the same clone + setup-agent.sh instructions the
		// original pairing dialog uses — re-running the script re-enrolls.
		await reenrollPill.click();
		await expect(page.getByRole("heading", { name: "Re-enroll this machine" })).toBeVisible();
		await expect(page.getByText(/setup-agent\.sh/)).toBeVisible();
	});

	test("the composer's own re-enroll link opens the same dialog", async ({ page }) => {
		await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);
		await page.getByRole("button", { name: "Re-enroll", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Re-enroll this machine" })).toBeVisible();
	});
});

test("an unreachable daemon is never reported as an expired enrollment", async ({ page }) => {
	await installBaseStubs(page);
	// A relay hiccup / offline daemon: the probe's request itself fails,
	// with nothing resembling `invalid_grant` anywhere in it.
	await page.route("**/api/v2/code/v1/providers?*", (route) => route.abort("connectionfailed"));

	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);
	await openAgentsPanel(page);

	// The strip renders (the agent snapshot read is unaffected); the pill
	// side of the panel must still call this device "paired", never
	// "re-enroll" — an offline probe is not evidence of a dead grant.
	await expect(page.getByRole("button", { name: "re-enroll", exact: true })).toHaveCount(0);
	await expect(page.getByText("paired", { exact: true })).toBeVisible();
	await expect(page.getByText(/enrollment expired or was revoked/i)).toHaveCount(0);
});

test.describe("live lists", () => {
	test("an agent created elsewhere appears in the tree without a reload", async ({ page }) => {
		await installBaseStubs(page);
		await page.route("**/api/v2/code/v1/providers?*", (route) =>
			route.fulfill({
				contentType: "application/json",
				body: superjsonBody({
					providers: [{ id: "opencode", available: true, enrollmentExpired: false }],
				}),
			})
		);

		let revealed = false;
		await page.route("**/api/v2/code/v1/agents?*", (route) =>
			route.fulfill({
				contentType: "application/json",
				body: superjsonBody({ agents: revealed ? [AGENT_SNAPSHOT] : [] }),
			})
		);

		await page.goto(`/code?device=${DEVICE}&ws=${WS}`);
		await openAgentsPanel(page);
		await expect(page.getByText("No agents yet.")).toBeVisible();
		await expect(page.getByText("e2e agent")).toHaveCount(0);

		// The daemon's own CLI (or another tab) started a session on this
		// workspace; nothing here navigated, so only the tree's own refetch
		// (the tab regaining focus, one of its two live-list triggers) can
		// surface it.
		revealed = true;
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));

		await expect(page.getByText("e2e agent")).toBeVisible({ timeout: 10_000 });
	});

	test("a device paired elsewhere appears in the Agents panel without a reload", async ({
		page,
	}) => {
		let paired = false;
		await page.route("**/api/v2/code/devices", (route) =>
			route.fulfill({
				contentType: "application/json",
				body: superjsonBody({
					devices: [
						{ id: DEVICE, name: "e2e box", status: "paired" },
						...(paired ? [{ id: DEVICE2, name: "second box", status: "paired" }] : []),
					],
				}),
			})
		);
		await page.route("**/api/v2/code/v1/workspaces?*", (route) =>
			route.fulfill({ contentType: "application/json", body: superjsonBody({ workspaces: [] }) })
		);
		await page.route("**/api/v2/code/v1/agents?*", (route) =>
			route.fulfill({ contentType: "application/json", body: superjsonBody({ agents: [] }) })
		);

		await page.goto("/code");
		await openAgentsPanel(page);
		await expect(page.getByText("e2e box")).toBeVisible();
		await expect(page.getByText("second box")).toHaveCount(0);

		paired = true;
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));

		await expect(page.getByText("second box")).toBeVisible({ timeout: 10_000 });
	});
});
