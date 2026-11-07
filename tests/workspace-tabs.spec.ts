/**
 * The workspace page's tab bar, through the real app: each tab is an address
 * (`/workspace?tab=<key>`), the current one is marked, and the sections that
 * absorbed Custom models and Local connectors (on in this stack through
 * LOCAL_CONNECTORS_ENABLED) are reachable, old addresses included.
 * What a tab's manager does is the per-area specs' business; this is the
 * frame around them.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

test("@smoke the workspace tabs navigate between managers, with Custom models and Local connectors as sections", async ({
	page,
}) => {
	await page.goto(`${E2E_APP_BASE}/workspace`);

	// Six tabs at most; Custom models and Local connectors are sections now.
	await expect(page.getByRole("link", { name: "Custom models", exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Local connectors", exact: true })).toHaveCount(0);
	// A bare /workspace is the Models tab, with the user's own models under it.
	await expect(page.getByRole("link", { name: "Models", exact: true })).toHaveAttribute(
		"aria-current",
		"page"
	);
	await expect(page.getByRole("heading", { name: "Your custom models", level: 2 })).toBeVisible();

	await page.getByRole("link", { name: "Connectors", exact: true }).click();
	await expect(page).toHaveURL(/\/workspace\?tab=mcp$/);
	await expect(page.getByRole("heading", { name: "On your computers", level: 2 })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Connect a computer" })).toBeVisible();

	// The address alone selects a tab, so a reload lands on the same one.
	await page.reload();
	await expect(page.getByRole("heading", { name: "Connect a computer" })).toBeVisible();
});

test("the old ?tab=local and ?tab=custom addresses redirect to their sections", async ({
	page,
}) => {
	await page.goto(`${E2E_APP_BASE}/workspace?tab=local`);
	await expect(page).toHaveURL(/\/workspace\?tab=mcp#on-your-machines$/);
	await expect(page.getByRole("heading", { name: "On your computers", level: 2 })).toBeVisible();

	await page.goto(`${E2E_APP_BASE}/workspace?tab=custom`);
	await expect(page).toHaveURL(/\/workspace\?tab=models#custom-models$/);
	await expect(page.getByRole("heading", { name: "Your custom models", level: 2 })).toBeVisible();
});
