/**
 * Collapsible devices and workspace groups in the `/code` sidebar (brief
 * item 1b): collapsed state (per device id, and per device id + workspace
 * id) survives a reload with its compact count badge, a collapsed device's
 * subtree is never fetched, and the active session's own device and
 * workspace always open expanded even when stored as collapsed.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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

async function addWorkspace(
	page: Page,
	deviceId: string,
	path: string,
	title: string
): Promise<string> {
	const res = await page.request.post(`${apiRoot}/v1/workspaces?device=${deviceId}`, {
		data: { path, title },
	});
	expect(res.ok()).toBe(true);
	const { workspace } = superjson.parse<{ workspace: { id: string } }>(await res.text());
	return workspace.id;
}

async function addSession(page: Page, deviceId: string, workspaceId: string): Promise<string> {
	const res = await page.request.post(`${apiRoot}/v1/agents?device=${deviceId}`, {
		data: { workspaceId, provider: "opencode", posture: "plan" },
	});
	expect(res.ok()).toBe(true);
	const { agent } = superjson.parse<{ agent: { id: string } }>(await res.text());
	return agent.id;
}

test.describe("collapsible devices and workspace groups", () => {
	test.skip(!opencodeAvailable(), "needs the opencode binary on PATH");
	test.describe.configure({ mode: "serial", timeout: 120_000 });

	let machineA: Machine | null = null;
	let machineB: Machine | null = null;

	// eslint-disable-next-line no-empty-pattern
	test.afterEach(async ({}, testInfo) => {
		if (testInfo.status !== testInfo.expectedStatus) {
			if (machineA) {
				testInfo.attach("galopin-a.log", { body: machineA.logs(), contentType: "text/plain" });
			}
			if (machineB) {
				testInfo.attach("galopin-b.log", { body: machineB.logs(), contentType: "text/plain" });
			}
		}
		await machineA?.stop();
		await machineB?.stop();
		machineA = null;
		machineB = null;
	});

	test("collapse persists with its badge, lazy-loads, and the active session stays expanded", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		machineA = await startMachine({ sub, name: `e2e-collapse-a-${randomUUID().slice(0, 6)}` });
		machineB = await startMachine({ sub, name: `e2e-collapse-b-${randomUUID().slice(0, 6)}` });

		const deviceAId = await waitForDeviceStatus(page, machineA.name, "pending");
		await confirmDevice(page, deviceAId);
		await addWorkspace(page, deviceAId, machineA.workspace, "a-repo");

		const deviceBId = await waitForDeviceStatus(page, machineB.name, "pending");
		await confirmDevice(page, deviceBId);
		const wsB1 = await addWorkspace(page, deviceBId, machineB.workspace, "b-active");
		const agentB1 = await addSession(page, deviceBId, wsB1);

		// A second, separately-collapsible workspace on the same (active)
		// device: any existing directory works — workspace.create only needs
		// a real dir, not a git repo.
		const wsB2Dir = join(machineB.root, "repo2");
		mkdirSync(wsB2Dir);
		const wsB2 = await addWorkspace(page, deviceBId, wsB2Dir, "b-collapsed");
		await addSession(page, deviceBId, wsB2);

		// Both devices start expanded by default, so this first load fetches
		// device A's subtree too (one workspace, "a-repo") — its count is
		// cached before anything is ever collapsed.
		await page.goto(`${E2E_APP_BASE}/code?device=${deviceBId}&ws=${wsB1}&agent=${agentB1}`);
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.locator('a[href*="&agent="]').first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("a-repo")).toBeVisible();

		// Collapse device A and workspace B2 — both already loaded, so both
		// badges are live at the moment of collapsing.
		await page.getByRole("button", { name: `Collapse ${machineA.name}` }).click();
		await page.getByRole("button", { name: "Collapse b-collapsed" }).click();

		// Watched only from here: requests to A's subtree after the reload below.
		const requestedDeviceASubtree: string[] = [];
		page.on("request", (req) => {
			const url = req.url();
			if (
				url.includes(`/api/v2/code/v1/workspaces?device=${deviceAId}`) ||
				url.includes(`/api/v2/code/v1/agents?device=${deviceAId}`)
			) {
				requestedDeviceASubtree.push(url);
			}
		});

		await page.reload();
		await page.getByRole("button", { name: "Agents", exact: true }).click();

		// The active session's device (B) and workspace (B1) open expanded —
		// its agent row is visible without touching either collapse toggle.
		await expect(page.locator(`a[href*="ws=${wsB1}"][href*="&agent="]`).first()).toBeVisible({
			timeout: 5_000,
		});

		// Device A stays collapsed with its cached workspace-count badge —
		// the point of persisting `deviceCounts` alongside the collapse set:
		// a fresh page load never re-fetches A (asserted below), yet its
		// badge still reads right.
		await expect(page.getByRole("button", { name: `Expand ${machineA.name}` })).toBeVisible();
		const aBadge = page.getByTestId("device-collapsed-count").filter({ hasText: "1 workspace" });
		await expect(aBadge).toBeVisible();

		// Workspace B2 stays collapsed with its cached, live session-count badge.
		await expect(page.getByRole("button", { name: "Expand b-collapsed" })).toBeVisible();
		const b2Badge = page.getByTestId("workspace-collapsed-count").filter({ hasText: "1 session" });
		await expect(b2Badge).toBeVisible();
		await expect(page.locator(`a[href*="ws=${wsB2}"][href*="&agent="]`)).toHaveCount(0);

		// Give the poll a beat, then assert A's subtree was never requested —
		// the point of lazy loading (1b).
		await page.waitForTimeout(1_000);
		expect(requestedDeviceASubtree).toEqual([]);

		// Expanding A now does fetch it, and shows its own workspace.
		await page.getByRole("button", { name: `Expand ${machineA.name}` }).click();
		await expect(page.getByText("a-repo")).toBeVisible({ timeout: 5_000 });
	});
});
