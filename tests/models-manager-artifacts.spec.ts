/**
 * The Models manager's Artifacts switch, and the new effective default it must
 * show: a tool-capable model with no `supportsArtifacts` flag at all (the
 * fixture's `test-org/test-model`, which advertises `supports_tools` on both
 * providers) now defaults to artifacts on, not off — `artifactsEnabledForTurn`
 * falls back to the model's tool-calling capability once neither the model
 * entry nor a per-user override says otherwise.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures.ts";

test("the Artifacts switch shows on by default for a tool-capable model", async ({ page }) => {
	await page.goto(`${E2E_APP_BASE}/workspace`);

	// The filter tokenizes on non-alphanumerics and matches each token as a
	// substring, so this also matches "test-org/thinking-model" (it too
	// contains "test", "org" and "model") — harmless: filtering preserves the
	// underlying array order, and the fixture lists this model first.
	await page.getByPlaceholder("Search by name").fill("test-org/test-model");
	await page.getByRole("button", { name: "Edit" }).first().click();

	// Confirms Edit opened the intended model, not the other fuzzy match.
	await expect(page.locator("code", { hasText: "test-org/test-model" })).toBeVisible();

	const artifactsSwitch = page.locator('input[name="model-artifacts"]');
	await expect(artifactsSwitch).toBeChecked();
});
