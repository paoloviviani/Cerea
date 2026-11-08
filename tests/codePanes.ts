import type { Locator, Page } from "playwright/test";

/**
 * A button of the agent screen's panel set (Tasks, Changes, Files, Terminal).
 * On a wide screen they sit inline in the header; on a phone, or when they
 * would not fit, they live behind the "Panels" button in a sheet. Returns the
 * inline button when it is there, otherwise opens the sheet and returns its
 * entry (selecting it closes the sheet again).
 */
export async function paneButton(page: Page, name: string, exact = true): Promise<Locator> {
	const inline = page.getByTestId("pane-buttons").getByRole("button", { name, exact });
	if (await inline.isVisible()) return inline;
	const sheet = page.getByTestId("panels-sheet");
	if (!(await sheet.isVisible())) await page.getByRole("button", { name: "Panels" }).click();
	return sheet.getByRole("button", { name, exact });
}
