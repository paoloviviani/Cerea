import { describe, expect, it } from "vitest";
import {
	TURN_LEAD_MS,
	formatCost,
	formatTokens,
	toGatewayUsage,
	totalTokens,
	turnQuery,
} from "./gatewayUsage";

const totals = {
	requests: 3,
	promptTokens: 1200,
	completionTokens: 300,
	cachedPromptTokens: 800,
	cost: "0.0123",
};

describe("toGatewayUsage", () => {
	it("is null when nothing is available", () => {
		expect(toGatewayUsage(null)).toBeNull();
		expect(toGatewayUsage({ available: false })).toBeNull();
		expect(
			toGatewayUsage({ available: true, currency: null, session: null, window: null })
		).toBeNull();
	});

	it("maps the window to the turn", () => {
		expect(
			toGatewayUsage({ available: true, currency: "EUR", session: totals, window: null })
		).toEqual({ currency: "EUR", session: totals, turn: null });
		expect(
			toGatewayUsage({ available: true, currency: "EUR", session: totals, window: totals })?.turn
		).toEqual(totals);
	});
});

describe("formatting", () => {
	it("totals prompt and completion tokens", () => {
		expect(totalTokens(totals)).toBe(1500);
	});

	it("keeps fractions of a cent", () => {
		expect(formatCost("0.0123", "EUR")).toContain("0.0123");
		expect(formatCost("2", "EUR")).toContain("2.00");
	});

	it("does not throw on an unknown currency or a bad number", () => {
		expect(formatCost("1.5", "ZZZZ")).toContain("1.50");
		expect(formatCost("1.5", null)).toBe("1.50");
		expect(formatCost("n/a", "EUR")).toBe("n/a");
	});

	it("abbreviates thousands", () => {
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(12_345)).toBe("12.3k");
	});
});

describe("turnQuery", () => {
	it("asks nothing without a turn", () => {
		expect(turnQuery(null, 1_000_000)).toBe("");
	});

	it("sends durations, with the window opened a little early", () => {
		expect(turnQuery({ startedAt: 940_000, endedAt: null }, 1_000_000)).toBe(
			`&sinceAgoMs=${60_000 + TURN_LEAD_MS}`
		);
		expect(turnQuery({ startedAt: 940_000, endedAt: 990_000 }, 1_000_000)).toBe(
			`&sinceAgoMs=${60_000 + TURN_LEAD_MS}&untilAgoMs=10000`
		);
	});
});
