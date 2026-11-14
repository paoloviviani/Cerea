import { describe, expect, it } from "vitest";
import { buildUpgradeCommand, galopinNeedsUpgrade } from "./galopinUpgrade";

describe("galopinNeedsUpgrade", () => {
	it("is true only for a parseable older version", () => {
		expect(galopinNeedsUpgrade("0.1.0", "0.52.2")).toBe(true);
		expect(galopinNeedsUpgrade("0.52.1", "0.52.2")).toBe(true);
		expect(galopinNeedsUpgrade("0.9.0", "0.52.2")).toBe(true);
		expect(galopinNeedsUpgrade("0.52.2", "0.52.2")).toBe(false);
		expect(galopinNeedsUpgrade("0.53.0", "0.52.2")).toBe(false);
		expect(galopinNeedsUpgrade("1.0.0", "0.52.2")).toBe(false);
		expect(galopinNeedsUpgrade(undefined, "0.52.2")).toBe(false);
		expect(galopinNeedsUpgrade("dev", "0.52.2")).toBe(false);
	});
});

describe("buildUpgradeCommand", () => {
	it("is the install line with --upgrade", () => {
		expect(buildUpgradeCommand("https://c.example/chat")).toBe(
			"curl -fsSL 'https://c.example/chat/galopin/install.sh' | sh -s -- --upgrade"
		);
	});
});
