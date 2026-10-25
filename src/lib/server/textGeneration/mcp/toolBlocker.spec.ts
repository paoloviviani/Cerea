import { describe, expect, it } from "vitest";
import { createToolBlocker } from "./toolBlocker";

describe("createToolBlocker", () => {
	it("blocks a tool after it fails the same way twice", () => {
		const blocker = createToolBlocker();
		blocker.recordFailure("search", "HTTP 500");
		expect(blocker.blocked("search")).toBe(false);
		blocker.recordFailure("search", "HTTP 500");
		expect(blocker.blocked("search")).toBe(true);
		expect(blocker.message("search")).toContain("unavailable for the rest of this turn");
		expect(blocker.message("search")).toContain("HTTP 500");
	});

	it("does not block when the second failure is a different error", () => {
		const blocker = createToolBlocker();
		blocker.recordFailure("search", "HTTP 500");
		blocker.recordFailure("search", "HTTP 404");
		expect(blocker.blocked("search")).toBe(false);
		// The tally restarted on the new error: one more of it makes two.
		blocker.recordFailure("search", "HTTP 404");
		expect(blocker.blocked("search")).toBe(true);
	});

	it("never blocks a different tool", () => {
		const blocker = createToolBlocker();
		blocker.recordFailure("search", "HTTP 500");
		blocker.recordFailure("search", "HTTP 500");
		expect(blocker.blocked("fetch")).toBe(false);
	});

	it("compares errors ignoring surrounding whitespace and ignores empty ones", () => {
		const blocker = createToolBlocker();
		blocker.recordFailure("search", "  HTTP 500\n");
		blocker.recordFailure("search", "HTTP 500");
		expect(blocker.blocked("search")).toBe(true);
		const other = createToolBlocker();
		other.recordFailure("x", "");
		other.recordFailure("x", "  ");
		expect(other.blocked("x")).toBe(false);
	});

	it("is scoped to the blocker, so a new turn starts clean", () => {
		const first = createToolBlocker();
		first.recordFailure("search", "e");
		first.recordFailure("search", "e");
		expect(createToolBlocker().blocked("search")).toBe(false);
	});
});
