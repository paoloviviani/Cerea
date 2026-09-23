/**
 * The /code dialogs on the operator's phone, hermetically: the /code
 * endpoints are stubbed at the network layer, so the client code paths are
 * the real ones (the pills/answer specs' pattern).
 *
 * What is pinned here: the new-agent dialog holds the small viewports the
 * operator actually uses — 360px and her 264px screenshot width — with the
 * posture pills and the footer buttons inside the viewport and side by side
 * (the workspace path in the subtitle is one unbreakable word, which used to
 * drive the modal's fit-content width past the screen and clip everything
 * past the first line); the pair dialog shows the machine's setup commands
 * with this deployment's own origin filled in and closes by itself when the
 * machine checks in as paired; and New Chat keeps its address while carrying
 * the switcher's small/icon idiom.
 */
import { test, expect, E2E_APP_URL } from "./fixtures";
import type { Page } from "playwright/test";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e";
const WORKSPACE_PATH = "/home/ubuntu/workspace";

const superjsonBody = (data: unknown) => superjson.stringify(data);

/** The paired-device rows the tree and the panel read; tests mutate this. */
let deviceRows: Array<Record<string, unknown>> = [];

async function stubCodePanel(page: Page) {
	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ devices: deviceRows }) })
	);
	await page.route("**/api/v2/code/v1/workspaces?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({
				workspaces: [{ id: WS, name: "repo", path: WORKSPACE_PATH }],
			}),
		})
	);
	await page.route("**/api/v2/code/v1/agents?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ agents: [] }) })
	);
	// The new-agent dialog reads the daemon's provider list on mount; the
	// stub answers before the dialog is measured, so no failure banner can
	// reflow the footer between two bounding-box reads.
	await page.route("**/api/v2/code/v1/providers?*", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ providers: [{ id: "opencode", available: true }] }),
		})
	);
}

/** Open the Agents panel (the mobile drawer) and then the new-agent dialog.
 * The drawer renders its own NavMenu beside the desktop rail's hidden copy,
 * so every tree control is addressed by its visible instance. */
function visibleTreeButton(page: Page, title: string) {
	return page.locator(`button[title='${title}']:visible`);
}

async function openAgentsPanel(page: Page) {
	await page.goto(`/code?device=${DEVICE}&ws=${WS}`);
	await page.getByRole("button", { name: "Open Agents panel" }).click();
}

async function openAgentDialog(page: Page) {
	await openAgentsPanel(page);
	await visibleTreeButton(page, "Start a coding session in this workspace").click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	// The provider list has landed (the loading note is gone) — past this
	// point the dialog's layout is stable.
	await expect(dialog.getByText("As configured on your daemon.")).toBeVisible();
}

/** A dialog holds the viewport: no clipping, nothing past its right edge. */
function expectInsideViewport(
	box: { x: number; y: number; width: number; height: number },
	width: number
) {
	expect(box.x).toBeGreaterThanOrEqual(-0.5);
	expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
}

/**
 * A control holds both axes of the viewport — used for the footer after a
 * failed create, where the risk is the *bottom* edge scrolling out of reach
 * (a real WebKit repro at 264x568, see tests/webkit-safari-check.ts), not
 * horizontal clipping.
 */
function expectInsideViewportBox(
	box: { x: number; y: number; width: number; height: number },
	width: number,
	height: number
) {
	expectInsideViewport(box, width);
	expect(box.y).toBeGreaterThanOrEqual(-0.5);
	expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
}

/** A bounding box or a clear failure — the null return is never useful here. */
async function boxOf(locator: ReturnType<Page["getByRole"]>) {
	const box = await locator.boundingBox();
	if (!box) throw new Error(`No bounding box for ${locator}`);
	return box;
}

test.describe("the new-agent dialog on a phone", () => {
	for (const [name, width, height] of [
		["360px", 360, 740],
		["the operator's 264px", 264, 568],
	] as const) {
		test(`holds at ${name}: pills and footer inside the viewport`, async ({ page }) => {
			deviceRows = [{ id: DEVICE, name: "e2e box", status: "paired" }];
			await stubCodePanel(page);
			await page.setViewportSize({ width, height });
			await openAgentDialog(page);

			const dialog = page.getByRole("dialog");
			expectInsideViewport(await boxOf(dialog), width);
			// Nothing clipped by the modal's overflow-x-hidden: the content
			// never wants to be wider than the dialog itself.
			const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
			expect(overflow).toBeLessThanOrEqual(0);

			// The posture pills render whole, inside the viewport.
			for (const label of ["Plan", "Write"]) {
				expectInsideViewport(await boxOf(dialog.getByRole("button", { name: label })), width);
			}

			// The footer buttons sit side by side — one row, disjoint x
			// ranges — and both inside the viewport.
			const cancel = await boxOf(dialog.getByRole("button", { name: "Cancel" }));
			const create = await boxOf(dialog.getByRole("button", { name: "Create agent" }));
			expect(Math.abs(cancel.y - create.y)).toBeLessThan(4);
			expect(create.x).toBeGreaterThanOrEqual(cancel.x + cancel.width - 0.5);
			expectInsideViewport(cancel, width);
			expectInsideViewport(create, width);

			await expect(page.getByText(WORKSPACE_PATH)).toBeVisible();
			await page.screenshot({ path: `test-results/agent-dialog-${width}.png` });
		});
	}
});

test.describe("the new-agent dialog after a failed create", () => {
	test("keeps the footer inside a short viewport (the operator's 264x568) when the daemon refuses", async ({
		page,
	}) => {
		deviceRows = [{ id: DEVICE, name: "e2e box", status: "paired" }];
		await stubCodePanel(page);
		// Overrides the GET-only stub above for this one request: the daemon
		// refuses the create, which is what mounts the error banner above
		// the form and grows the dialog's content — the trigger for the
		// real bug (confirmed on WebKit, see tests/webkit-safari-check.ts):
		// on a short viewport that growth pushes past the shell's
		// `max-height`, and a non-sticky footer scrolls out of reach with
		// no cue that scrolling the dialog itself would reveal it.
		await page.route("**/api/v2/code/v1/agents?*", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ message: "The daemon refused the request." }),
			});
		});
		await page.setViewportSize({ width: 264, height: 568 });
		await openAgentDialog(page);

		const dialog = page.getByRole("dialog");
		await dialog.getByRole("button", { name: "Create agent" }).click();
		await expect(dialog.getByText("Agent failed")).toBeVisible();

		expectInsideViewportBox(await boxOf(dialog.getByRole("button", { name: "Cancel" })), 264, 568);
		expectInsideViewportBox(
			await boxOf(dialog.getByRole("button", { name: "Create agent" })),
			264,
			568
		);
		await page.screenshot({ path: "test-results/agent-dialog-264-after-fail.png" });
	});
});

test.describe("the pair dialog's setup commands", () => {
	test.beforeEach(async ({ page }) => {
		// No devices yet: the tree's empty state offers "Pair a device" itself.
		deviceRows = [];
		await stubCodePanel(page);
		await page.setViewportSize({ width: 360, height: 740 });
	});

	test("shows the clone and setup commands with the deployment's origin, and closes when the machine checks in", async ({
		page,
	}) => {
		// The enroll start is recorded and answers a pending row, the way
		// Cerea's own broker does.
		const enrollBodies: unknown[] = [];
		await page.route("**/api/v2/code/enroll", async (route) => {
			enrollBodies.push(route.request().postDataJSON());
			return route.fulfill({
				contentType: "application/json",
				body: superjsonBody({
					device: {
						id: "dev_pending",
						name: "test box",
						status: "pending",
						pairingCode: "ABC234",
						createdAt: new Date(),
					},
				}),
			});
		});

		await openAgentsPanel(page);
		await visibleTreeButton(page, "Pair a new device").click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.getByLabel("Device name").fill("test box");
		await page.getByRole("button", { name: "Start pairing" }).click();

		// The paste step is gone; the setup commands carry this deployment's
		// own origin (the e2e stack's PUBLIC_ORIGIN), its real OIDC issuer
		// (OPENID_PROVIDER_URL, which the e2e stack deliberately points off
		// the app's own origin so a hardcoded `${origin}/authelia` guess
		// cannot pass this assertion by accident) and the typed name.
		const dialog = page.getByRole("dialog");
		await expect(
			dialog.getByText("git clone https://github.com/paoloviviani/Pystino.git")
		).toBeVisible();
		await expect(dialog.getByText("cd Pystino/deploy/opencode")).toBeVisible();
		const relay = new URL(E2E_APP_URL).host;
		await expect(
			dialog.getByText(
				`./setup-agent.sh --relay ${relay} --gateway ${E2E_APP_URL} --issuer http://127.0.0.1:9/authelia --name "test box" --yes`
			)
		).toBeVisible();
		await expect(dialog.getByLabel("Pairing link")).toHaveCount(0);
		expect(enrollBodies).toEqual([{ action: "start", name: "test box" }]);

		// The commands never clip on a phone.
		const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(overflow).toBeLessThanOrEqual(0);

		// The machine pairs itself: the row arrives as `paired` through the
		// machine endpoint, and the dialog closes onto it without a paste.
		deviceRows = [
			{
				id: "dev_new",
				name: "test box",
				status: "paired",
				daemonId: "srv_new",
				createdAt: new Date(),
				pairedAt: new Date(),
			},
		];
		await expect(dialog).toHaveCount(0, { timeout: 15_000 });
		expect(page.url()).toContain(`device=dev_new`);
	});
});

test("New Chat keeps its address and carries the switcher's small icon idiom", async ({ page }) => {
	deviceRows = [{ id: DEVICE, name: "e2e box", status: "paired" }];
	await stubCodePanel(page);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(`/code?device=${DEVICE}`);

	const newChat = page.getByRole("link", { name: "New Chat" });
	await expect(newChat).toBeVisible();
	// Same address and shortcut tooltip as before; the icon is the
	// switcher's own affordance (an svg inside the link).
	await expect(newChat).toHaveAttribute("href", "/");
	await expect(newChat).toHaveAttribute("title", "Ctrl/Cmd + Shift + O");
	await expect(newChat.locator("svg")).toHaveCount(1);
});
