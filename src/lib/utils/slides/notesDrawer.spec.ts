import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Read from disk: the test runner hands `?raw` CSS imports back empty.
const baseCss = readFileSync(new URL("./slides.css", import.meta.url), "utf8");

/** The presenter notes drawer sits over any deck, including a model's own dark
 * design that never sets reveal's colour variables; it must not borrow them. */
describe("notes drawer", () => {
	const rule = /\.cerea-notes\s*\{([^}]*)\}/.exec(baseCss)?.[1] ?? "";

	it("has its own opaque background and light text", () => {
		expect(rule).toMatch(/background:\s*rgba\(17,\s*20,\s*28,\s*0\.96\)/);
		expect(rule).toMatch(/color:\s*#e8ebf2/);
	});

	it("does not take its colours from the deck", () => {
		expect(rule).not.toMatch(/var\(--r-main-color\)/);
		expect(rule).not.toMatch(/background:\s*var\(--cerea-surface\)/);
	});
});
