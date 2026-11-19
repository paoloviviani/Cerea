import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The top fade is CSS and applies at every width: the chat and the /code session view
// both scroll under the top bar, on desktop as on phones. Pin that no rule that keys on
// data-top-fade is confined to a viewport-width media query.
describe("appearance.css top fade", () => {
	const css = readFileSync(new URL("./appearance.css", import.meta.url), "utf8");

	it("applies at every width", () => {
		const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
		const stack: string[] = [];
		let head = "";
		let seen = 0;
		for (const ch of bare) {
			if (ch === "{") {
				stack.push(head.trim());
				if (head.includes("[data-top-fade]")) {
					seen++;
					expect(stack.some((h) => /^@media \((min|max)-width/.test(h))).toBe(false);
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

	it("fades about 1.75rem (28px) and keeps the composer fade with a page background", () => {
		expect(css).toContain("linear-gradient(to bottom, transparent, #000 1.75rem)");
		expect(css).toMatch(/:root\[data-background\] \.chat-scroller\[data-top-fade\]/);
	});
});
