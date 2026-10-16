import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "@vitest/browser/context";
import UpdateBanner from "./UpdateBanner.svelte";
import { appReload } from "$lib/utils/appReload";

afterEach(() => vi.restoreAllMocks());

describe("UpdateBanner", () => {
	it("renders nothing while the version is current", async () => {
		render(UpdateBanner, { show: false });
		await expect.element(page.getByTestId("update-banner")).not.toBeInTheDocument();
	});

	it("offers a reload when a new version is out, and reloads on click", async () => {
		const spy = vi.spyOn(appReload, "reload").mockImplementation(() => {});
		render(UpdateBanner, { show: true });
		await expect.element(page.getByText("A new version is available.")).toBeInTheDocument();
		await page.getByRole("button", { name: "Reload" }).click();
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
