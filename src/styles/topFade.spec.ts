import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The top fade is CSS, so the guarantee that desktop is unchanged is the
// shape of the stylesheet: every rule that keys on data-top-fade sits inside
// the phone media query (the md breakpoint is where the floating bar hides).
describe("appearance.css top fade", () => {
	const css = readFileSync(new URL("./appearance.css", import.meta.url), "utf8");

	it("only ever applies on phones", () => {
		const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
		const stack: string[] = [];
		let head = "";
		let seen = 0;
		for (const ch of bare) {
			if (ch === "{") {
				stack.push(head.trim());
				if (head.includes("[data-top-fade]")) {
					seen++;
					expect(stack.some((h) => h.startsWith("@media (max-width: 767.98px)"))).toBe(true);
				}
				head = "";
			} else if (ch === "}") {
				stack.pop();
				head = "";
			} else if (ch === ";") {
				head = "";
			} else head += ch;
		}
		expect(seen).toBeGreaterThanOrEqual(3);
	});

	it("fades about 1.25rem (20px) and keeps the composer fade with a page background", () => {
		expect(css).toContain("linear-gradient(to bottom, transparent, #000 1.25rem)");
		expect(css).toMatch(/:root\[data-background\] \.chat-scroller\[data-top-fade\]/);
	});
});
