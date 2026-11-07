import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import StopGeneratingBtn from "./StopGeneratingBtn.svelte";

describe("the Stop button's ring", () => {
	it("sweeps by angle and stays inside the button's box, wide or square", async () => {
		const screen = render(StopGeneratingBtn, {
			showBorder: true,
			showText: true,
			classNames: "h-7 min-w-7 rounded-full border px-2.5",
		});
		const btn = screen.container.querySelector("button") as HTMLElement;
		const ring = getComputedStyle(btn, "::after");
		// A rotated pseudo-element on a pill swings out over its neighbours.
		expect(ring.animationName).toContain("stop-generating-sweep");
		expect(ring.transform).toBe("none");
		expect(ring.position).toBe("absolute");
	});
});
