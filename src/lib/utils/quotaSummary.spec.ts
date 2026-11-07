import { describe, expect, it } from "vitest";
import { summariseQuota } from "./quotaSummary";

const section = (entries: object[]) => ({ title: "t", entries }) as never;

describe("summariseQuota", () => {
	it("returns nothing for an empty or missing report", () => {
		expect(summariseQuota(null)).toBeNull();
		expect(summariseQuota({ sections: [] })).toBeNull();
	});

	it("prefers a limit over a bare spend, and money over counts, and the user's own over a shared one", () => {
		const picked = summariseQuota({
			sections: [
				section([
					{ label: "tokens", used: 5, limit: 10, unit: "tokens", scope: "user" },
					{ label: "group money", used: 5, limit: 10, unit: "EUR", scope: "group" },
					{ label: "money", used: 2, limit: 10, unit: "EUR", scope: "user" },
					{ label: "spend", used: 99, unit: "EUR" },
				]),
			],
		});
		expect(picked?.kind).toBe("limit");
		expect(picked?.entry.label).toBe("money");
	});

	it("flags near-limit from 80% and clamps the bar at 100%", () => {
		const at = (used: number) =>
			summariseQuota({ sections: [section([{ label: "m", used, limit: 100, unit: "EUR" }])] });
		expect(at(79)).toMatchObject({ near: false, percent: 79 });
		expect(at(80)).toMatchObject({ near: true });
		expect(at(250)).toMatchObject({ near: true, percent: 100 });
	});

	it("falls back to the spend alone when nothing has a limit, in money only", () => {
		expect(
			summariseQuota({ sections: [section([{ label: "s", used: 4, unit: "EUR" }])] })
		).toMatchObject({ kind: "spend", used: 4 });
		expect(
			summariseQuota({ sections: [section([{ label: "r", used: 40, unit: "requests" }])] })
		).toBeNull();
	});

	it("skips shared budgets, unreadable counters and failed sections", () => {
		expect(
			summariseQuota({
				sections: [
					{ title: "x", entries: [], error: "down" },
					section([
						{ label: "shared", unit: "EUR", limit: 10, noFigures: true },
						{ label: "unreadable", used: 0, unit: "EUR", limit: 10, unknown: true },
					]),
				],
			})
		).toBeNull();
	});
});
