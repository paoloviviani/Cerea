import { describe, it, expect } from "vitest";
import { extractThink, stripThink } from "./stripThink";

describe("stripThink", () => {
	it("leaves text without reasoning untouched", () => {
		expect(stripThink("Python string reversal")).toBe("Python string reversal");
	});

	it("removes a complete block and its contents", () => {
		expect(stripThink("<think>deliberating</think>Python string reversal")).toBe(
			"Python string reversal"
		);
	});

	it("removes an unterminated block left by a budget cutoff", () => {
		expect(stripThink("<think>We need to produce a title. The user is")).toBe("");
	});

	it("removes every block when several are present", () => {
		expect(stripThink("<think>a</think>one<think>b</think>two")).toBe("onetwo");
	});

	it("keeps text that precedes a block", () => {
		expect(stripThink("visible<think>hidden</think>")).toBe("visible");
	});
});

describe("extractThink", () => {
	it("returns no blocks for plain text", () => {
		expect(extractThink("Python string reversal")).toEqual([]);
	});

	it("collects a single block's inner content", () => {
		expect(extractThink("<think>deliberating</think>Python string reversal")).toEqual([
			"deliberating",
		]);
	});

	it("collects an unterminated block up to the end of the string", () => {
		expect(extractThink("<think>We need to produce a title. The user is")).toEqual([
			"We need to produce a title. The user is",
		]);
	});

	it("collects every block when several are present", () => {
		expect(extractThink("<think>a</think>one<think>b</think>two")).toEqual(["a", "b"]);
	});

	it("partitions content identically with stripThink", () => {
		const content = "visible<think>hidden</think>tail<think>more";
		const thinking = extractThink(content).join("");
		expect(thinking).toBe("hiddenmore");
		// Everything that is neither answer nor thinking is inter-block markup,
		// which neither side may claim twice.
		expect(stripThink(content)).toBe("visibletail");
	});
});
