/**
 * The /code stale-sign-in block, against the real server (the other /code
 * specs stub `/status` and every machine route, so none of them can see it).
 *
 * A person whose sign-in is older than 7 days — or recorded with no time at
 * all — gets one card and nothing else: the server answers `401
 * reauth_required` to everything under `/api/v2/code/` but `/status`, so the
 * page never learns a machine's name. A fresh sign-in gets the panel.
 */
import { test, expect, CODE_STATUS_GLOB, E2E_APP_BASE } from "./fixtures.ts";
import { seedUser } from "./machineHarness.ts";
import type { Db } from "mongodb";

const DAY = 24 * 3600 * 1000;

async function signInWith(db: Db, sessionId: string, authTime: Date | null) {
	await seedUser(db, sessionId, "e2e-stale-sub");
	await db
		.collection("sessions")
		.updateOne({ sessionId }, authTime ? { $set: { authTime } } : { $unset: { authTime: "" } });
}

test.describe("a stale /code sign-in", () => {
	for (const [label, authTime] of [
		["8 days old", new Date(Date.now() - 8 * DAY)],
		["not recorded at all", null],
	] as const) {
		test(`shows the one card and asks no machine for anything (${label})`, async ({
			page,
			db,
			session,
		}) => {
			await signInWith(db, session.sessionId, authTime);
			// The real answer, not the fixture's: this spec is about it.
			await page.unroute(CODE_STATUS_GLOB);
			const machineRequests: string[] = [];
			page.on("request", (request) => {
				const url = new URL(request.url());
				if (
					url.pathname.includes("/api/v2/code/") &&
					!url.pathname.endsWith("/api/v2/code/status")
				) {
					machineRequests.push(`${request.method()} ${url.pathname}`);
				}
			});

			await page.goto(`${E2E_APP_BASE}/code`);
			await expect(page.getByTestId("code-reauth-card")).toBeVisible();
			await expect(
				page.getByText("Your sign-in is older than 7 days. Sign in again to see your machines.")
			).toBeVisible();
			const signIn = page.getByRole("link", { name: "Sign in" });
			await expect(signIn).toHaveAttribute(
				"href",
				`${E2E_APP_BASE}/login?reauth=1&next=${E2E_APP_BASE}/code`
			);
			// The switch stays; the tree, the inbox and the terminal tab do not exist.
			await expect(page.getByTestId("sidebar-view-agents").first()).toBeVisible();
			await expect(page.getByTestId("needs-you-inbox")).toHaveCount(0);
			await expect(page.getByTestId("device-rail")).toHaveCount(0);
			expect(machineRequests).toEqual([]);
		});
	}

	test("the server itself refuses a call the page was never going to make", async ({
		page,
		db,
		session,
	}) => {
		await signInWith(db, session.sessionId, new Date(Date.now() - 8 * DAY));
		await page.goto(`${E2E_APP_BASE}/`);
		const refused = await page.evaluate(async (base) => {
			const response = await fetch(`${base}/api/v2/code/devices`);
			return { status: response.status, body: await response.text() };
		}, E2E_APP_BASE);
		expect(refused.status).toBe(401);
		expect(refused.body).toContain("reauth_required");
		const status = await page.evaluate(async (base) => {
			const response = await fetch(`${base}/api/v2/code/status`);
			return { status: response.status, body: await response.text() };
		}, E2E_APP_BASE);
		expect(status.status).toBe(200);
		expect(status.body).toContain("reauthPath");
		expect(status.body).not.toContain("devices");
	});
});

test.describe("a fresh /code sign-in", () => {
	test("gets the panel, not the card", async ({ page, db, session }) => {
		await signInWith(db, session.sessionId, new Date(Date.now() - 1 * DAY));
		await page.unroute(CODE_STATUS_GLOB);
		await page.goto(`${E2E_APP_BASE}/code`);
		await expect(page.getByText("No paired devices").first()).toBeVisible();
		await expect(page.getByTestId("code-reauth-card")).toHaveCount(0);
	});
});

test.describe("a session that died mid-page", () => {
	// The hourly expiry of a chat without a refresh token: the row is gone
	// (or its token expired) while a tab sits open. The panel's way back is
	// the plain sign-in — the provider's own SSO session answers it
	// silently — never the forced `reauth=1` prompt.
	test("the page leaves for the plain sign-in, and never the forced one", async ({
		page,
		db,
		session,
	}) => {
		await signInWith(db, session.sessionId, new Date(Date.now() - 1 * DAY));
		await page.unroute(CODE_STATUS_GLOB);
		await page.goto(`${E2E_APP_BASE}/code`);
		await expect(page.getByText("No paired devices").first()).toBeVisible();

		await db.collection("sessions").deleteOne({ sessionId: session.sessionId });
		// Returning to the tab re-asks /status; a reload folds the same way.
		// The signed-out answer navigates the page itself:
		await page.reload();
		await page.waitForURL(/\/login\?/);
		expect(page.url()).toContain("next=");
		expect(page.url()).not.toContain("reauth=1");
	});

	test("with the loop guard holding the redirect, the signed-out card stays, with the plain link", async ({
		page,
		db,
		session,
	}) => {
		await signInWith(db, session.sessionId, new Date(Date.now() - 1 * DAY));
		await page.unroute(CODE_STATUS_GLOB);
		// A redirect that already happened in the last minute is not
		// repeated: the card shows instead. Seed the guard so this test can
		// see that card — it is what a person whose sign-in is not coming
		// back (cookies blocked, provider down) is left looking at.
		await page.addInitScript(() => {
			try {
				window.sessionStorage.setItem("code-signedout-redirect-at", String(Date.now()));
			} catch {
				/* private mode: the guard degrades to always-redirect */
			}
		});
		await page.goto(`${E2E_APP_BASE}/code`);
		await expect(page.getByText("No paired devices").first()).toBeVisible();

		await db.collection("sessions").deleteOne({ sessionId: session.sessionId });
		await page.reload();

		const card = page.getByTestId("code-reauth-card");
		await expect(card).toBeVisible();
		await expect(card).toHaveAttribute("data-variant", "signed-out");
		await expect(
			page.getByText("You were signed out. Sign in again to see your machines.")
		).toBeVisible();
		const signIn = page.getByRole("link", { name: "Sign in" });
		await expect(signIn).toHaveAttribute("href", `${E2E_APP_BASE}/login?next=${E2E_APP_BASE}/code`);
		await expect(signIn).not.toHaveAttribute("href", /reauth=1/);
	});
});
