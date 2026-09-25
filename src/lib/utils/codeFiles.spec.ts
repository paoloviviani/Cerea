import { describe, it, expect } from "vitest";
import { badgeOf, gitBadges, humanSize } from "./codeFiles";

describe("git badges", () => {
	it("maps porcelain-v2 codes to one letter", () => {
		expect(badgeOf(".", "M")).toBe("M");
		expect(badgeOf("A", ".")).toBe("A");
		expect(badgeOf("D", ".")).toBe("D");
		expect(badgeOf("R", ".")).toBe("R");
		expect(badgeOf("U", "U")).toBe("U");
		expect(badgeOf("?", "?")).toBe("?");
		expect(badgeOf(".", ".")).toBeNull();
	});

	it("rolls the strongest change up to every folder above it", () => {
		const badges = gitBadges([
			{ path: "src/app.ts", x: ".", y: "M" },
			{ path: "src/lib/new.ts", x: "?", y: "?" },
			{ path: "src/lib/gone.ts", x: "D", y: "." },
			{ path: "README.md", x: "A", y: "." },
		]);
		expect(badges.get("src/app.ts")).toBe("M");
		expect(badges.get("src/lib")).toBe("D");
		expect(badges.get("src")).toBe("D");
		expect(badges.get("README.md")).toBe("A");
		expect(badges.has("docs")).toBe(false);
	});
});

describe("humanSize", () => {
	it("reads like a file manager", () => {
		expect(humanSize(512)).toBe("512 B");
		expect(humanSize(2355)).toBe("2.3 KB");
		expect(humanSize(2.3 * 1024 * 1024)).toBe("2.3 MB");
	});
});
