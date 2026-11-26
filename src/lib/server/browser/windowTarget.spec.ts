import { describe, expect, it } from "vitest";
import { OTHER_REPLICA_MESSAGE, windowRefusal, windowTargetWins } from "./windowTarget";

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

describe("a window this process does not hold", () => {
	const base = { windowId: "w".repeat(32), hasWindow: false, scheduledRun: false };

	it("with several replicas the turn refuses, in plain words, instead of using a computer", () => {
		expect(windowRefusal({ ...base, replicas: 2 })).toBe(OTHER_REPLICA_MESSAGE);
		expect(OTHER_REPLICA_MESSAGE).not.toMatch(/replica|_/);
	});

	it("with one replica the window is just gone, and computers are used as before", () => {
		expect(windowRefusal({ ...base, replicas: 1 })).toBeUndefined();
	});

	it("never refuses a turn that names no window, one that has its window, or a scheduled run", () => {
		expect(windowRefusal({ ...base, windowId: undefined, replicas: 3 })).toBeUndefined();
		expect(windowRefusal({ ...base, hasWindow: true, replicas: 3 })).toBeUndefined();
		expect(windowRefusal({ ...base, scheduledRun: true, replicas: 3 })).toBeUndefined();
	});
});
