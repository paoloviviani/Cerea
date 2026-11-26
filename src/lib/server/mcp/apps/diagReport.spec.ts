import { beforeEach, describe, expect, it } from "vitest";
import { reduceSource, reportAllowed, resetReports } from "./diagReport";

describe("the diagnostics report", () => {
	beforeEach(resetReports);

	it("keeps a source as scheme, host and path only", () => {
		expect(reduceSource("https://cdn.example.com/a/b.js?token=secret#frag")).toBe(
			"https://cdn.example.com/a/b.js"
		);
		expect(reduceSource("https://user:pw@cdn.example.com/x?y=1")).toBe("https://cdn.example.com/x");
		expect(reduceSource("data:text/html,<p>secret</p>")).toBe("data:");
		expect(reduceSource("not a url")).toBeUndefined();
		expect(reduceSource(undefined)).toBeUndefined();
	});

	it("limits each bucket separately", () => {
		for (let i = 0; i < 10; i += 1) expect(reportAllowed("c|1", 1000)).toBe(true);
		expect(reportAllowed("c|1", 1000)).toBe(false);
		expect(reportAllowed("u|1", 1000)).toBe(true);
		expect(reportAllowed("c|1", 62_000)).toBe(true);
	});
});
