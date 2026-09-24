/**
 * Credential health and keeping the sidebar's device/agent lists live without
 * a reload.
 *
 * Unlike the paseo-era daemon this replaces, the machine reports its own
 * credential health directly (`hello`/`credential` frames, spec §5) — there
 * is no separate network probe to run before the first send, and no
 * dedicated "re-enroll" flow (a fresh `pystino-agent enroll` mints a new
 * machine id, so re-enrolling is just pairing again). This suite pins:
 *
 * - a paired device whose row reports `credentialState: "expired"` shows a
 *   "credential expired" pill instead of "online"/"paired", and the
 *   composer refuses to send before any message is typed;
 * - an offline device (`online: false`) never claims a dead credential —
 *   the two are independent facts — and the tree never even tries to load
 *   its workspaces/agents (X4: it is never asked, so it cannot hang);
 * - a device paired, or an agent created, from elsewhere (another tab, the
 *   machine's own reconnect) appears in the tree once the tab's quiet poll
 *   or its focus refetch runs, with no page reload.
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
};

function deviceRow(overrides: Record<string, unknown> = {}) {
	return {
		id: DEVICE,
		name: "e2e box",
		status: "paired",
		online: true,
		credentialState: "ok",
		backends: [],
		policy: { autoAccept: "denied", workspaceRoots: [], allowFreeModels: false },
		createdAt: new Date(),
		...overrides,
	};
}

/** The pill/panel's shared plumbing every scenario below needs: the device
 * row, its workspace, its agent's snapshot and the pills' option lists.
 * Each scenario supplies its own `devices` route so it can vary
 * `credentialState`/`online`. */
async function installBaseStubs(page: Page, agentEnrollmentExpired = false) {
	await page.route(`**/api/v2/code/v1/agents/${AGENT}?*`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				agent: AGENT_SNAPSHOT,
				features: [],
				cwd: "/repo",
				enrollmentExpired: agentEnrollmentExpired,
			}),
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
			body: `id: e1:1\nevent: update\ndata: ${JSON.stringify({ type: "turnState", state: "done", serverNow: Date.now() })}\n\n`,
		})
	);
}

test.describe("a machine reporting an expired credential", () => {
	test.beforeEach(async ({ page }) => {
		await installBaseStubs(page, true);
		await page.route("**/api/v2/code/devices", (route) =>
			route.fulfill({
				contentType: "application/json",
				body: superjsonBody({ devices: [deviceRow({ credentialState: "expired" })] }),
			})
		);
	});

	test("shows a credential-expired pill and refuses the send before any message", async ({
		page,
	}) => {
		await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);
		await openAgentsPanel(page);

		// The device's own row in the Agents panel: neither "online" nor
		// "paired" claims a good credential once the machine says otherwise.
		await expect(page.getByText("credential expired", { exact: true })).toBeVisible();
		await expect(page.getByText("online", { exact: true })).toHaveCount(0);

		// The composer refuses the send it knows is doomed — before the
		// person has typed anything, let alone pressed enter.
		await expect(page.getByText(/enrollment expired or was revoked/i)).toBeVisible();
		await page.getByPlaceholder("Follow up with the agent…").fill("are you there?");
		await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();

		// Its own re-enroll link opens the pairing dialog — a fresh
		// enrollment is a new pending machine, not an in-place fix.
		await page.getByRole("button", { name: "Re-enroll", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Pair a machine" })).toBeVisible();
	});
});

test("an offline device never reads as a dead credential, and its tree is never even asked", async ({
	page,
}) => {
	let workspacesRequested = false;
	await installBaseStubs(page);
	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ devices: [deviceRow({ online: false })] }),
		})
	);
	// Overrides installBaseStubs' handler: this scenario asserts the tree
	// never calls it at all for an offline device (X4).
	await page.route("**/api/v2/code/v1/workspaces?*", (route) => {
		workspacesRequested = true;
		return route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ workspaces: [] }),
		});
	});

	await page.goto(`/code?device=${DEVICE}&ws=${WS}&agent=${AGENT}`);
	await openAgentsPanel(page);

	await expect(page.getByText("Offline.", { exact: true })).toBeVisible();
	await expect(page.getByText("credential expired", { exact: true })).toHaveCount(0);
	await expect(page.getByText(/enrollment expired or was revoked/i)).toHaveCount(0);
	expect(workspacesRequested).toBe(false);
});

test.describe("live lists", () => {
	test("an agent created elsewhere appears in the tree without a reload", async ({ page }) => {
		await installBaseStubs(page);
		await page.route("**/api/v2/code/devices", (route) =>
			route.fulfill({
				contentType: "application/json",
				body: superjsonBody({ devices: [deviceRow()] }),
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

		// The machine's own reconnect (or another tab) started a session on
		// this workspace; nothing here navigated, so only the tree's own
		// refetch (the tab regaining focus, one of its two live-list
		// triggers) can surface it.
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
						deviceRow(),
						...(paired ? [deviceRow({ id: DEVICE2, name: "second box" })] : []),
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
