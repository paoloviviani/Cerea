import UsageBar from "./UsageBar.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it } from "vitest";
import type { UsageEntry } from "$lib/types/UsageReport";

describe("UsageBar", () => {
	it("renders a progress bar for an entry with a limit", () => {
		const entry: UsageEntry = {
			label: "Monthly tokens",
			used: 250,
			limit: 1000,
			unit: "tokens",
			scope: "user",
		};
		const { container } = renderWithApp(UsageBar, { entry });

		const bar = container.querySelector('[role="progressbar"]');
		expect(bar).not.toBeNull();
		expect(bar?.getAttribute("aria-valuenow")).toBe("250");
		expect(bar?.getAttribute("aria-valuemax")).toBe("1000");
		expect(container.textContent).toContain("Monthly tokens");
		expect(container.textContent).toContain("250");
		expect(container.textContent).toContain("1,000");
	});

	it("renders 'unknown' rather than a 0% bar when current_value was null", () => {
		const entry: UsageEntry = {
			label: "Team requests",
			used: 0,
			limit: 500,
			unit: "requests",
			scope: "group",
			unknown: true,
		};
		const { container } = renderWithApp(UsageBar, { entry });

		const bar = container.querySelector('[role="progressbar"]');
		expect(bar?.getAttribute("aria-valuenow")).toBeNull();
		expect(bar?.getAttribute("aria-valuetext")).toBe("unknown");
		expect(container.textContent).toContain("unknown");
		expect(container.textContent).not.toContain("0 /");
	});

	it("renders a plain stat, no progress bar, when there is no limit", () => {
		const entry: UsageEntry = {
			label: "You — spend",
			used: 3.5,
			unit: "USD",
			scope: "user",
			period: "per day",
		};
		const { container } = renderWithApp(UsageBar, { entry });

		expect(container.querySelector('[role="progressbar"]')).toBeNull();
		expect(container.textContent).toContain("You — spend");
		expect(container.textContent).toContain("$3.50");
		expect(container.textContent).toContain("per day");
	});
});
