/**
 * The workspace page's tab bar, through the real app: each tab is an address
 * (`/workspace?tab=<key>`), the current one is marked, and On your computers
 * (on in this stack through LOCAL_CONNECTORS_ENABLED) shows its way in.
 * What a tab's manager does is the per-area specs' business; this is the
 * frame around them.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

test("@smoke the workspace tabs navigate between managers, On your computers included", async ({
	page,
}) => {
	await page.goto(`${E2E_APP_BASE}/workspace`);

	const tabs = page.getByRole("link", { name: /^(Models|Custom models|On your computers)$/ });
	await expect(tabs).toHaveCount(3);
	// A bare /workspace is the Models tab.
	await expect(page.getByRole("link", { name: "Models", exact: true })).toHaveAttribute(
		"aria-current",
		"page"
	);

	await page.getByRole("link", { name: "Custom models", exact: true }).click();
	await expect(page).toHaveURL(/\/workspace\?tab=custom$/);
	await expect(page.getByRole("heading", { name: "Custom models", level: 2 })).toBeVisible();

	await page.getByRole("link", { name: "On your computers", exact: true }).click();
	await expect(page).toHaveURL(/\/workspace\?tab=local$/);
	await expect(page.getByRole("link", { name: "On your computers", exact: true })).toHaveAttribute(
		"aria-current",
		"page"
	);
	await expect(page.getByRole("heading", { name: "Connect a computer" })).toBeVisible();

	// The address alone selects a tab, so a reload lands on the same one.
	await page.reload();
	await expect(page.getByRole("heading", { name: "Connect a computer" })).toBeVisible();
});
