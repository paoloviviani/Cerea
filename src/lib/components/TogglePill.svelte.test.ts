import { describe, it, expect } from "vitest";
import { page } from "@vitest/browser/context";
import { createRawSnippet } from "svelte";
import { render } from "vitest-browser-svelte";
import TogglePill from "./TogglePill.svelte";

const icon = createRawSnippet(() => ({ render: () => `<svg data-testid="pill-icon"></svg>` }));

function mount(props: { pressed: boolean; compact?: boolean; badge?: string }) {
	return render(TogglePill, { label: "Changes", onclick: () => {}, icon, ...props });
}

describe("TogglePill compact", () => {
	it("keeps the label for assistive tech under sm and shows an icon-only button", async () => {
		await page.viewport(400, 800);
		const screen = mount({ pressed: false, compact: true });
		const button = screen.getByRole("button", { name: "Changes" });
		await expect.element(button).toBeVisible();

		// Still the button's accessible name, but out of the visual layout.
		const label = button.element().querySelector("span");
		expect(label?.textContent).toBe("Changes");
		expect(label?.className).toContain("max-sm:sr-only");
		const box = label?.getBoundingClientRect();
		expect(box?.width).toBeLessThanOrEqual(1);
		expect(box?.height).toBeLessThanOrEqual(1);
		expect(button.element().getBoundingClientRect().width).toBe(32);
	});

	it("shows the label at sm and up", async () => {
		await page.viewport(1000, 800);
		const screen = mount({ pressed: false, compact: true });
		const label = screen.getByRole("button", { name: "Changes" }).element().querySelector("span");
		expect(label?.getBoundingClientRect().width).toBeGreaterThan(20);
	});

	it("carries the state in aria-pressed", async () => {
		const off = mount({ pressed: false, compact: true });
		await expect
			.element(off.getByRole("button", { name: "Changes" }))
			.toHaveAttribute("aria-pressed", "false");
		off.unmount();
		const on = mount({ pressed: true, compact: true });
		await expect
			.element(on.getByRole("button", { name: "Changes" }))
			.toHaveAttribute("aria-pressed", "true");
	});
});

describe("TogglePill badge", () => {
	it("keeps a small count visible under sm, where the label is hidden", async () => {
		await page.viewport(400, 800);
		const screen = mount({ pressed: false, compact: true, badge: "3/7" });
		const badge = screen.getByTestId("pill-badge");
		await expect.element(badge).toBeVisible();
		expect(badge.element().textContent).toBe("3/7");
	});

	it("is hidden at sm and up, where the label already carries it", async () => {
		await page.viewport(1000, 800);
		const screen = mount({ pressed: false, compact: true, badge: "3/7" });
		await expect.element(screen.getByTestId("pill-badge")).not.toBeVisible();
	});

	it("does not add a second copy of the count to the accessible name", async () => {
		const screen = mount({ pressed: false, compact: true, badge: "3/7" });
		await expect.element(screen.getByRole("button", { name: "Changes" })).toBeInTheDocument();
	});
});
