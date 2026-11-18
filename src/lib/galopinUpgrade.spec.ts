import { describe, expect, it } from "vitest";
import { buildUpgradeCommand, galopinNeedsUpgrade, galopinUnsupported } from "./galopinUpgrade";

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

describe("galopin changed-since logic", () => {
	it("does not flag a computer when Cerea moved on but galopin did not", () => {
		// Cerea 0.56.0, galopin last changed in 0.55.1: a 0.55.2 computer is current.
		expect(galopinNeedsUpgrade("0.55.2", "0.55.1")).toBe(false);
		expect(galopinNeedsUpgrade("0.55.1", "0.55.1")).toBe(false);
	});
	it("flags a galopin older than the last change", () => {
		expect(galopinNeedsUpgrade("0.55.0", "0.55.1")).toBe(true);
	});
	it("flags below the minimum as unsupported (the strong warning), and only then", () => {
		expect(galopinUnsupported("0.30.0", "0.40.0")).toBe(true);
		expect(galopinUnsupported("0.40.0", "0.40.0")).toBe(false);
		expect(galopinUnsupported("0.45.0", "0.40.0")).toBe(false);
		expect(galopinUnsupported(undefined, "0.40.0")).toBe(false);
	});
});
