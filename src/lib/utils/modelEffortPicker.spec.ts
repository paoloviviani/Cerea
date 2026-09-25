import { describe, it, expect } from "vitest";
import { chatEffort, effortLabel, readRecent, shortList, withRecent } from "./modelEffortPicker";

const models = [
	{ id: "org/alpha", name: "Alpha", description: "Fast and small" },
	{ id: "org/beta", name: "Beta", description: "Reasoning model" },
	{ id: "org/gamma", name: "Gamma" },
	...Array.from({ length: 8 }, (_, i) => ({ id: `org/m${i}`, name: `M${i}` })),
];

describe("the short list", () => {
	it("puts the current model first, then recent picks, at most six", () => {
		const recent = ["org/beta", "org/gone", "org/m1", "org/m2", "org/m3", "org/m4", "org/m5"];
		const rows = shortList(models, "org/alpha", recent, "");
		expect(rows.map((r) => r.id)).toEqual([
			"org/alpha",
			"org/beta",
			"org/m1",
			"org/m2",
			"org/m3",
			"org/m4",
		]);
	});

	it("searches every model by id, name and description, current first", () => {
		expect(shortList(models, "org/gamma", [], "reasoning").map((r) => r.id)).toEqual(["org/beta"]);
		expect(shortList(models, "org/beta", [], "org a").map((r) => r.id)[0]).toBe("org/beta");
		expect(shortList(models, "org/alpha", [], "nothing like it")).toEqual([]);
	});
});

describe("effort", () => {
	it("labels Default when none is chosen", () => {
		expect(effortLabel(undefined)).toBe("Default");
		expect(effortLabel("high")).toBe("High");
	});

	it("resolves the preset, then the conversation, then the user default", () => {
		expect(chatEffort({ preset: "high", conversation: "low", userDefault: "medium" })).toBe("high");
		expect(chatEffort({ conversation: "low", userDefault: "medium" })).toBe("low");
		expect(chatEffort({ userDefault: "medium" })).toBe("medium");
		expect(chatEffort({})).toBeUndefined();
	});
});

describe("recent picks", () => {
	it("keeps the latest first, once, and survives bad storage", () => {
		expect(withRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
		expect(readRecent({ getItem: () => '["x","y"]' })).toEqual(["x", "y"]);
		expect(readRecent({ getItem: () => "not json" })).toEqual([]);
		expect(readRecent(undefined)).toEqual([]);
	});
});
