import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "@vitest/browser/context";
import TableGrid from "./TableGrid.svelte";

const wide = (cols: number) =>
	`${Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(",")}\n` +
	`${Array.from({ length: cols }, (_, i) => `A fairly long value for cell ${i + 1}`).join(",")}\n`;

describe("TableGrid on a narrow panel", () => {
	it("scrolls sideways, fades the right edge, and pins the first column", async () => {
		await page.viewport(390, 700);
		const screen = render(TableGrid, { content: wide(8) });
		await expect.element(screen.getByTestId("table-fade-right")).toBeInTheDocument();
		expect(screen.container.querySelector('[data-testid="table-fade-left"]')).toBeNull();
		const first = screen.container.querySelector("tbody td");
		expect(first?.className).toContain("sticky");

		const scroller = screen.container.querySelector(".overflow-auto") as HTMLElement;
		scroller.scrollLeft = 200;
		scroller.dispatchEvent(new Event("scroll"));
		await expect.element(screen.getByTestId("table-fade-left")).toBeInTheDocument();
	});

	it("shows no fade when the table fits", async () => {
		await page.viewport(1200, 700);
		const screen = render(TableGrid, { content: "A,B\n1,2\n" });
		expect(screen.container.querySelector('[data-testid="table-fade-right"]')).toBeNull();
	});

	it("keeps the wide table inside its panel: the scroller is the table's own and cells wrap", async () => {
		await page.viewport(390, 700);
		const screen = render(TableGrid, { content: wide(8) });
		const grid = screen.container.querySelector('[data-testid="table-grid"]') as HTMLElement;
		const scroller = screen.container.querySelector(
			'[data-testid="table-scroller"]'
		) as HTMLElement;
		// The scroller never grows past the panel; the overflow is inside it.
		expect(scroller.getBoundingClientRect().right).toBeLessThanOrEqual(
			grid.getBoundingClientRect().right + 1
		);
		expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
		const cell = screen.container.querySelector("tbody td") as HTMLElement;
		expect(getComputedStyle(cell).textOverflow).not.toBe("ellipsis");
	});
});
