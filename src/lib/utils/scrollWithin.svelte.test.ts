import { afterEach, describe, expect, it } from "vitest";
import { scrollParent, scrollWithin } from "./scrollWithin";

/**
 * The bug: a link in a page's own column scrolled the whole app window. The app's
 * root is `fixed overflow-hidden`; `scrollIntoView` scrolls it anyway. These
 * mount the same shape (an overflow-hidden root over a column that scrolls) and
 * check that only the column moves.
 */
describe("scrollWithin", () => {
	let root: HTMLElement;

	afterEach(() => root?.remove());

	function mountShape() {
		root = document.createElement("div");
		root.style.cssText =
			"position:fixed;inset:0;overflow:hidden;display:grid;grid-template-rows:auto 1fr";
		root.innerHTML = `
			<header style="height:40px">header</header>
			<div id="column" style="overflow-y:auto;min-height:0">
				<div style="height:1200px">filler</div>
				<h2 id="target" style="height:30px;margin:0">target</h2>
				<div style="height:1200px">filler</div>
			</div>`;
		document.body.appendChild(root);
		return {
			column: root.querySelector("#column") as HTMLElement,
			target: root.querySelector("#target") as HTMLElement,
		};
	}

	it("scrolls the column to the target and leaves the app root and the window where they were", () => {
		const { column, target } = mountShape();

		expect(scrollWithin(target)).toBe(true);

		expect(column.scrollTop).toBeGreaterThan(1000);
		expect(root.scrollTop).toBe(0);
		expect(document.scrollingElement?.scrollTop ?? 0).toBe(0);
		// The target is at the top of the column, header untouched.
		expect(
			Math.abs(target.getBoundingClientRect().top - column.getBoundingClientRect().top)
		).toBeLessThan(2);
		expect(root.querySelector("header")?.getBoundingClientRect().top).toBe(0);
	});

	it("leaves room above the target for a bar that sticks to the column's top", () => {
		const { column, target } = mountShape();

		scrollWithin(target, { offset: 56 });

		const gap = target.getBoundingClientRect().top - column.getBoundingClientRect().top;
		expect(Math.round(gap)).toBe(56);
	});

	it("scrolls back up too, and never past the top", () => {
		const { column, target } = mountShape();
		column.scrollTop = 2000;
		scrollWithin(column.firstElementChild as HTMLElement, { offset: 100 });
		expect(column.scrollTop).toBe(0);
		expect(scrollWithin(target)).toBe(true);
	});

	it("finds the nearest ancestor that really scrolls, and none when nothing does", () => {
		const { column, target } = mountShape();
		expect(scrollParent(target)).toBe(column);
		const lone = document.createElement("p");
		root.appendChild(lone);
		expect(scrollWithin(lone)).toBe(false);
	});
});
