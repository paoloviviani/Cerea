import { describe, expect, it } from "vitest";
import { parseSandboxSettings } from "./config";

describe("sandbox settings", () => {
	it("is off by default and says nothing", () => {
		expect(parseSandboxSettings({})).toEqual({ config: null, mode: "off", problems: [] });
		expect(parseSandboxSettings({ SANDBOX: "off" }).problems).toEqual([]);
	});

	it("is on only when the mode, the URL and the token all agree", () => {
		const s = parseSandboxSettings({
			SANDBOX: "local",
			SANDBOX_MANAGER_URL: "http://sandbox-manager:8080/",
			SANDBOX_MANAGER_TOKEN: "tok",
		});
		expect(s.config).toEqual({ mode: "local", url: "http://sandbox-manager:8080", token: "tok" });
		expect(s.problems).toEqual([]);
		expect(
			parseSandboxSettings({
				SANDBOX: "remote",
				SANDBOX_MANAGER_URL: "https://sandbox.example.org",
				SANDBOX_MANAGER_TOKEN: "tok",
			}).config?.mode
		).toBe("remote");
	});

	it("never turns a half-set switch on, and reports the mismatch", () => {
		const noToken = parseSandboxSettings({
			SANDBOX: "local",
			SANDBOX_MANAGER_URL: "http://m:8080",
		});
		expect(noToken.config).toBeNull();
		expect(noToken.problems.join()).toMatch(/SANDBOX_MANAGER_TOKEN/);
		const noUrl = parseSandboxSettings({ SANDBOX: "remote", SANDBOX_MANAGER_TOKEN: "t" });
		expect(noUrl.config).toBeNull();
		expect(noUrl.problems.join()).toMatch(/SANDBOX_MANAGER_URL/);
		const stray = parseSandboxSettings({
			SANDBOX: "off",
			SANDBOX_MANAGER_URL: "http://m",
			SANDBOX_MANAGER_TOKEN: "t",
		});
		expect(stray.config).toBeNull();
		expect(stray.problems.join()).toMatch(/stay off/);
		const typo = parseSandboxSettings({
			SANDBOX: "yes",
			SANDBOX_MANAGER_URL: "http://m",
			SANDBOX_MANAGER_TOKEN: "t",
		});
		expect(typo.config).toBeNull();
		expect(typo.mode).toBe("off");
		expect(typo.problems.length).toBeGreaterThan(0);
	});
});
