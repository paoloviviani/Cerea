import { describe, it, expect } from "vitest";
import { badgeOf, fileSaveBlock, fileUploadAllowed, gitBadges, humanSize } from "./codeFiles";

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

describe("fileSaveBlock", () => {
	const allowed = {
		machine: { capabilities: { fileWrite: true } },
		policy: { fileWrite: "allowed" as const },
	};
	it("is null only when the deployment, the galopin and the policy all allow saving", () => {
		expect(fileSaveBlock(true, allowed)).toBeNull();
	});
	it("names the first half that says no", () => {
		expect(fileSaveBlock(false, allowed)).toBe("deployment");
		expect(fileSaveBlock(true, { ...allowed, machine: { capabilities: {} } })).toBe("machine");
		expect(fileSaveBlock(true, { ...allowed, policy: { fileWrite: "denied" } })).toBe("policy");
		expect(fileSaveBlock(true, { machine: allowed.machine })).toBe("policy");
		expect(fileSaveBlock(true, undefined)).toBe("machine");
	});
});

describe("fileUploadAllowed", () => {
	it("needs saving allowed and the fileUpload capability", () => {
		const cap = { machine: { capabilities: { fileUpload: true } } };
		expect(fileUploadAllowed(null, cap)).toBe(true);
		expect(fileUploadAllowed("policy", cap)).toBe(false);
		expect(fileUploadAllowed(null, { machine: { capabilities: {} } })).toBe(false);
		expect(fileUploadAllowed(null, undefined)).toBe(false);
	});
});
