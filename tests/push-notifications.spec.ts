/**
 * Web Push, hermetic: the Settings → Notifications screen against a real
 * build, and the service worker's own handling of a push (delivered through
 * the DevTools protocol, since no push service is reachable here).
 *
 * Set PUSH_SHOT_DIR to also write screenshots of the screen.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE, E2E_APP_ORIGIN } from "./fixtures";
import { seedUser } from "./machineHarness";

// The default headless shell has no notification backend: it reports the
// permission as denied whatever is granted. Full Chromium in headless mode has one.
test.use({ channel: "chromium" });

const SHOT_DIR = process.env.PUSH_SHOT_DIR;

async function seedDevices(db: import("mongodb").Db, userId: unknown) {
	const now = new Date();
	await db.collection("pushSubscriptions").insertMany([
		{
			userId,
			endpoint: "https://push.example.net/a",
			p256dh: "k",
			auth: "a",
			label: "Chrome on Android",
			createdAt: new Date(now.getTime() - 3 * 86400_000),
			lastSeenAt: now,
			lastPushAt: new Date(now.getTime() - 3600_000),
		},
		{
			userId,
			endpoint: "https://push.example.net/b",
			p256dh: "k",
			auth: "a",
			label: "Firefox on Linux",
			createdAt: new Date(now.getTime() - 86400_000),
			lastSeenAt: now,
		},
	]);
}

async function shot(page: Page, name: string) {
	if (!SHOT_DIR) return;
	mkdirSync(SHOT_DIR, { recursive: true });
	await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: false });
}

test.describe("Settings → Notifications", () => {
	test("shows the events, the devices, and the test button", async ({ page, db, session }) => {
		const userId = await seedUser(db, session.sessionId, `e2e-${randomUUID()}`);
		await seedDevices(db, userId);
		await page.goto(`${E2E_APP_BASE}/settings/notifications`);
		await expect(page.getByText("Tell me when")).toBeVisible();
		await expect(page.getByText("An agent needs you")).toBeVisible();
		await expect(page.getByTestId("push-device")).toHaveCount(2);
		await expect(page.getByRole("button", { name: "Send a test notification" })).toBeEnabled();
		await expect(page.getByRole("switch")).toHaveCount(5);

		// A toggle persists.
		await page.getByRole("switch").nth(4).click();
		await expect
			.poll(async () => (await db.collection("settings").findOne({ userId }))?.pushEvents)
			.toMatchObject({ chatTurn: true });

		// Removing a device removes only that row.
		await page.getByRole("button", { name: "Remove" }).first().click();
		await expect(page.getByTestId("push-device")).toHaveCount(1);
		expect(await db.collection("pushSubscriptions").countDocuments({})).toBe(1);
	});

	for (const [w, h, tag] of [
		[1440, 900, "desktop"],
		[390, 844, "phone"],
	] as const) {
		for (const scheme of ["light", "dark"] as const) {
			test(`screenshots ${tag} ${scheme}`, async ({ page, db, session }) => {
				test.skip(!SHOT_DIR, "PUSH_SHOT_DIR not set");
				const userId = await seedUser(db, session.sessionId, `e2e-${randomUUID()}`);
				await seedDevices(db, userId);
				await page.setViewportSize({ width: w, height: h });
				await page.emulateMedia({ colorScheme: scheme });
				await page.goto(`${E2E_APP_BASE}/settings/notifications`);
				await expect(page.getByTestId("push-device")).toHaveCount(2);
				await shot(page, `settings-notifications-${tag}-${scheme}`);
			});
		}
	}
});

test.describe("service worker", () => {
	test("shows a pushed notification, skipping it while the app is in front", async ({
		page,
		context,
		session,
		db,
	}) => {
		void session;
		void db;
		await context.grantPermissions(["notifications"], { origin: E2E_APP_ORIGIN });
		await page.goto(`${E2E_APP_BASE}/settings/notifications`);
		const registrationUrl = await page.evaluate(async (base) => {
			const reg =
				(await navigator.serviceWorker.getRegistration(`${base}/`)) ??
				(await navigator.serviceWorker.register(`${base}/service-worker.js`, {
					scope: `${base}/`,
				}));
			await navigator.serviceWorker.ready;
			return reg.scope;
		}, E2E_APP_BASE);
		expect(registrationUrl).toBe(`${E2E_APP_ORIGIN}${E2E_APP_BASE}/`);

		const cdp = await context.newCDPSession(page);
		await cdp.send("ServiceWorker.enable");
		const registrationId = await new Promise<string>((resolve) => {
			cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => {
				const r = e.registrations.find((x) => x.scopeURL === registrationUrl);
				if (r) resolve(r.registrationId);
			});
		});
		const push = (event: string, title: string) =>
			cdp.send("ServiceWorker.deliverPushMessage", {
				origin: E2E_APP_ORIGIN,
				registrationId,
				data: JSON.stringify({
					v: 1,
					title,
					body: "body",
					url: `${E2E_APP_BASE}/code`,
					event,
					tag: event,
				}),
			});
		const shown = () =>
			page.evaluate(async () => {
				const reg = await navigator.serviceWorker.ready;
				return (await reg.getNotifications()).map((n) => n.title);
			});

		// A real push while the window is visible and focused: skipped.
		await page.bringToFront();
		await push("permission", "Needs you");
		await page.waitForTimeout(1000);
		expect(await shown()).toEqual([]);

		// The test notification is always shown.
		await push("test", "Notifications are on");
		await expect.poll(shown).toEqual(["Notifications are on"]);
	});
});
