/**
 * The Application settings page names the running release: "Cerea X.Y.Z",
 * linking to its GitHub release, from package.json at build time (the image's
 * runtime env does not carry the version).
 */
import { readFileSync } from "node:fs";
import { test, expect, E2E_APP_BASE } from "./fixtures";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the Application settings page shows the release version", async ({ page }) => {
	await page.goto(`${E2E_APP_BASE}/settings/application`);
	const line = page.getByTestId("app-version");
	await expect(line).toContainText(`Cerea ${version}`);
	await expect(line.getByRole("link", { name: `Cerea ${version}` })).toHaveAttribute(
		"href",
		`https://github.com/paoloviviani/Cerea/releases/tag/v${version}`
	);
});
