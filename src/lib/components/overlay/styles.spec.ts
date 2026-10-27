import { describe, expect, it } from "vitest";
import { PILL } from "./styles";

describe("PILL", () => {
	// A pill sits beside a title that truncates; with a large system font it
	// wrapped onto two lines ("Built-" / "in") and squeezed the title instead.
	it("never wraps or shrinks", () => {
		const classes = PILL.split(/\s+/);
		expect(classes).toContain("whitespace-nowrap");
		expect(classes).toContain("shrink-0");
	});
});
