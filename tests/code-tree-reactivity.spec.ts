/**
 * The `/code` sidebar tree's device/workspace/agent rows must appear
 * without a manual page reload, on every path a person actually takes:
 *
 *  - a hard refresh of `/code` with a device that already has data
 *    (the regression bound for brief item 1: measured before the fix,
 *    galopin's own `session.list` answered in tens of ms even with 100+
 *    tracked sessions, but the browser waited ~8.6s to show the first row —
 *    `CodeNavTree.svelte`'s `refreshTrees()` had no reactive tie to the
 *    device list resolving, so a fresh page sat empty until the next 8s
 *    poll tick);
 *  - a device that finishes connecting *after* the tree is already mounted
 *    and polling;
 *  - switching the sidebar from Chats to Agents (a client-side mount, no
 *    navigation) when the device was already paired and populated before
 *    that switch.
 *
 * All three exercise the same fix: `CodeNavTree`'s `$effect` that loads a
 * newly-loadable device's subtree immediately, and its per-device
 * streaming `trees` update, instead of a `Promise.all` that only painted
 * once every device had answered and only ever ran again on the next
 * `TREE_POLL_MS` tick.
 */
import { randomUUID } from "node:crypto";
import superjson from "superjson";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE, E2E_APP_URL } from "./fixtures";
import { opencodeAvailable, seedUser, startMachine, type Machine } from "./machineHarness";

const apiRoot = `${E2E_APP_URL}/api/v2/code`;

interface DeviceRow {
	id: string;
	name: string;
	status: string;
}

/** Polls `GET /devices` through `page.request` (no UI, no navigation —
 * cookies ride with the browser context regardless of what page is
 * loaded) until `name` reaches `status`. */
async function waitForDeviceStatus(page: Page, name: string, status: string): Promise<string> {
	const deadline = Date.now() + 60_000;
	for (;;) {
		const res = await page.request.get(`${apiRoot}/devices`);
		const { devices } = superjson.parse<{ devices: DeviceRow[] }>(await res.text());
		const found = devices.find((d) => d.name === name && d.status === status);
		if (found) return found.id;
		if (Date.now() > deadline) {
			throw new Error(`device ${name} never reached status ${status}: ${JSON.stringify(devices)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

async function confirmDevice(page: Page, deviceId: string): Promise<void> {
	const res = await page.request.patch(`${apiRoot}/devices?id=${deviceId}`, {
		data: { action: "confirm" },
	});
	expect(res.ok()).toBe(true);
}

async function addWorkspace(page: Page, deviceId: string, path: string): Promise<string> {
	const res = await page.request.post(`${apiRoot}/v1/workspaces?device=${deviceId}`, {
		data: { path, title: "repo" },
	});
	expect(res.ok()).toBe(true);
	const { workspace } = superjson.parse<{ workspace: { id: string } }>(await res.text());
	return workspace.id;
}

async function addSession(page: Page, deviceId: string, workspaceId: string): Promise<void> {
	const res = await page.request.post(`${apiRoot}/v1/agents?device=${deviceId}`, {
		data: { workspaceId, provider: "opencode", posture: "plan" },
	});
	expect(res.ok()).toBe(true);
}

const firstAgentRow = (page: Page) => page.locator('a[href*="&agent="]').first();

test.describe("the /code tree appears without a manual reload", () => {
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

	test("a device that comes online after the page has loaded still gets its subtree", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);

		// The tree mounts and starts polling before the machine exists at all.
		await page.goto(`${E2E_APP_BASE}/code`);
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.getByRole("navigation").getByText("No paired devices")).toBeVisible();

		machine = await startMachine({ sub });
		const deviceId = await waitForDeviceStatus(page, machine.name, "pending");
		await confirmDevice(page, deviceId);
		const workspaceId = await addWorkspace(page, deviceId, machine.workspace);
		await addSession(page, deviceId, workspaceId);

		// No reload from here: the already-mounted tree must pick up the
		// newly-online, newly-populated device on its own.
		await expect(firstAgentRow(page)).toBeVisible({ timeout: 3_000 });
	});

	test("switching from Chats to Agents shows an already-populated device without a reload", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machine = await startMachine({ sub });

		// Everything is set up before the browser ever loads a page: pairing,
		// the workspace and the session all happen over `page.request`, which
		// carries the session cookie regardless of what (if anything) is
		// currently on screen.
		const deviceId = await waitForDeviceStatus(page, machine.name, "pending");
		await confirmDevice(page, deviceId);
		const workspaceId = await addWorkspace(page, deviceId, machine.workspace);
		await addSession(page, deviceId, workspaceId);

		// The one navigation in this test: a fresh load of the chat home,
		// where the sidebar starts on Chats (never mounts CodeNavTree yet) —
		// confirmed by the agent row's absence before the switch below.
		await page.goto(`${E2E_APP_BASE}/`);
		await expect(page.getByTestId("sidebar-view-chats")).toBeVisible();
		await expect(firstAgentRow(page)).toHaveCount(0);

		// A client-side switch, not a navigation: CodeNavTree mounts for the
		// first time in this tab right here, with the device already paired,
		// online and populated.
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(firstAgentRow(page)).toBeVisible({ timeout: 2_000 });
	});

	test("a hard refresh with many sessions shows the first rows well under the old poll interval", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machine = await startMachine({ sub });

		await page.goto(`${E2E_APP_BASE}/code`);
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		const deviceId = await waitForDeviceStatus(page, machine.name, "pending");
		await confirmDevice(page, deviceId);
		const workspaceId = await addWorkspace(page, deviceId, machine.workspace);

		// Enough tracked sessions to have shown the galopin-side O(N²)
		// ChildSummary cost too, had it still been there (sessions_test.go's
		// TestChildSummariesMatchesChildSummary is the unit-level guard for
		// that; this is the end-to-end guard for the reload symptom).
		const SESSION_COUNT = 20;
		const CONCURRENCY = 5;
		for (let i = 0; i < SESSION_COUNT; i += CONCURRENCY) {
			await Promise.all(
				Array.from({ length: Math.min(CONCURRENCY, SESSION_COUNT - i) }, () =>
					addSession(page, deviceId, workspaceId)
				)
			);
		}

		// The measured event: reload, then time to the first visible row.
		// Before the fix this was ~8.6s (a full TREE_POLL_MS tick); the fix
		// makes it one round trip plus render, so 2s is a generous bound that
		// still catches a regression back to poll-interval-gated loading.
		await page.goto(`${E2E_APP_BASE}/code?device=${deviceId}`);
		await expect(firstAgentRow(page)).toBeVisible({ timeout: 2_000 });
	});
});
