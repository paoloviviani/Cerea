import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("$lib/server/config", () => ({
	config: new Proxy({}, { get: (_t, key: string) => env.values[key] ?? "" }),
}));

const { BROWSER_DEFAULTS, boundedNumber, browserEnabled, browserSettings } =
	await import("./settings");

beforeEach(() => {
	env.values = {};
});

describe("browser settings", () => {
	it("is off by default, with sane budgets and empty lists", () => {
		expect(browserEnabled()).toBe(false);
		expect(browserSettings()).toEqual({
			enabled: false,
			model: "",
			budgets: { ...BROWSER_DEFAULTS },
			rules: { allow: [], deny: [] },
		});
		expect(BROWSER_DEFAULTS).toEqual({ maxSteps: 25, maxTokens: 200_000, maxSeconds: 300 });
	});

	it("is on only for exactly true", () => {
		for (const value of ["TRUE", "1", "yes", "on", ""]) {
			env.values.CHAT_BROWSER_ENABLED = value;
			expect(browserEnabled()).toBe(false);
		}
		env.values.CHAT_BROWSER_ENABLED = "true";
		expect(browserEnabled()).toBe(true);
	});

	it("reads the model, budgets and lists", () => {
		env.values = {
			CHAT_BROWSER_ENABLED: "true",
			CHAT_BROWSER_MODEL: " browser-model ",
			CHAT_BROWSER_MAX_STEPS: "40",
			CHAT_BROWSER_MAX_TOKENS: "500000",
			CHAT_BROWSER_MAX_SECONDS: "120",
			CHAT_BROWSER_SITES_ALLOW: "shop.example.com\n*.example.org",
			CHAT_BROWSER_SITES_DENY: "bank.test, https://pay.test/x",
		};
		expect(browserSettings()).toEqual({
			enabled: true,
			model: "browser-model",
			budgets: { maxSteps: 40, maxTokens: 500_000, maxSeconds: 120 },
			rules: { allow: ["shop.example.com", "*.example.org"], deny: ["bank.test", "pay.test"] },
		});
	});

	it("clamps a number into its limits and falls back on junk", () => {
		expect(boundedNumber("100000", "maxSteps")).toBe(100);
		expect(boundedNumber("0", "maxSteps")).toBe(1);
		expect(boundedNumber("-5", "maxSeconds")).toBe(10);
		expect(boundedNumber("abc", "maxTokens")).toBe(200_000);
		expect(boundedNumber(undefined, "maxSeconds")).toBe(300);
		expect(boundedNumber("", "maxSteps")).toBe(25);
	});
});
