import { describe, expect, it } from "vitest";
import { windowTargetWins } from "./windowTarget";

const ready = [
	{ id: "a".repeat(24), name: "Laptop" },
	{ id: "b".repeat(24), name: "Work Desk" },
];

describe("window or computer", () => {
	it("a window beats every computer by default", () => {
		expect(windowTargetWins({ ready, userText: "search for rain" })).toBe(true);
		expect(windowTargetWins({ ready: [], userText: "search" })).toBe(true);
	});
	it("a computer wins only when the model's hint is its exact name AND the user's words name it", () => {
		expect(windowTargetWins({ ready, hint: "laptop", userText: "do it on my Laptop please" })).toBe(
			false
		);
		expect(windowTargetWins({ ready, hint: "Work Desk", userText: "use the work desk" })).toBe(
			false
		);
	});
	it("a hint the user did not say, a name that is not a computer, or no user text never leaves the window", () => {
		expect(windowTargetWins({ ready, hint: "Laptop", userText: "search for rain" })).toBe(true);
		expect(windowTargetWins({ ready, hint: "Phone", userText: "use my Phone" })).toBe(true);
		expect(windowTargetWins({ ready, hint: "Laptop" })).toBe(true);
		expect(windowTargetWins({ ready, hint: "Lap", userText: "on my Laptop" })).toBe(true);
	});
});
