/**
 * The interface follows the browser's language until the user chooses one.
 * An Italian Accept-Language (Playwright's `locale` sets it) gets Italian
 * chrome and `<html lang="it">`; picking English in Settings persists across a
 * reload and wins over the header; "use my browser's language" gives the
 * header back its say.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

test.use({ locale: "it-IT" });

test("an Italian Accept-Language shows Italian chrome", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${E2E_APP_BASE}/`);
	await expect(page.locator("html")).toHaveAttribute("lang", "it");
	await expect(page.getByRole("link", { name: "Nuova chat" }).first()).toBeVisible();
	await expect(page.getByRole("link", { name: "Impostazioni" }).first()).toBeVisible();
});

test("the language picker persists a choice over the header, and can hand control back", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${E2E_APP_BASE}/settings/application`);
	const picker = page.locator("#language-select");
	await expect(picker).toHaveValue("auto");
	await expect(picker.locator("option[value=auto]")).toHaveText("Usa la lingua del mio browser");

	await picker.selectOption("en");
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await expect(page.locator("#language-select")).toHaveValue("en");
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await expect(page.locator("#language-select")).toHaveValue("en");

	await page.locator("#language-select").selectOption("auto");
	await expect(page.locator("html")).toHaveAttribute("lang", "it");
	await expect(page.locator("#language-select")).toHaveValue("auto");
});
