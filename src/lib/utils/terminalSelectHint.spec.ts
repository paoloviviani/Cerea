import { describe, expect, it } from "vitest";
import { isMacPlatform } from "./terminalSelectHint";

describe("isMacPlatform", () => {
	it("detects macOS through userAgentData or the legacy platform", () => {
		expect(
			isMacPlatform({ platform: "", userAgent: "", userAgentData: { platform: "macOS" } })
		).toBe(true);
		expect(isMacPlatform({ platform: "MacIntel", userAgent: "Mozilla" })).toBe(true);
	});
	it("is false for Linux, Windows and iOS", () => {
		expect(isMacPlatform({ platform: "Linux x86_64", userAgent: "X11" })).toBe(false);
		expect(isMacPlatform({ platform: "Win32", userAgent: "Windows" })).toBe(false);
		expect(isMacPlatform({ platform: "iPhone", userAgent: "iPhone OS" })).toBe(false);
		expect(isMacPlatform({ platform: "MacIntel", userAgent: "iPad; CPU OS" })).toBe(false);
	});
});
