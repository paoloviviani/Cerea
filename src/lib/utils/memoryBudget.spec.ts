/**
 * The prompt's memory budget: which stored facts fit, decided newest-first.
 *
 * Pins the arithmetic the server block builder and the Memory screen share —
 * one copy both import, so the screen's "no longer being sent" marks can
 * never disagree with the prompt. Newest wins because recent facts are the
 * ones a tight budget should keep; one fact always survives because silence
 * is a worse answer than a single long line.
 */
import { describe, expect, it } from "vitest";
import { MEMORY_BLOCK_MAX_CHARS } from "$lib/types/Memory";
import { fitMemoriesToBudget } from "./memoryBudget";

describe("fitMemoriesToBudget", () => {
	it("keeps everything when it all fits, omitting nothing", () => {
		expect(fitMemoriesToBudget(["First fact.", "Second fact.", "Third fact."], 1000)).toEqual({
			included: [0, 1, 2],
			omitted: 0,
		});
	});

	it("drops the oldest facts first when the budget is tight", () => {
		const texts = ["oldest fact", "middle fact", "newest fact"];
		// Room for exactly the two most recent: the oldest is the one left out.
		const budget = "middle fact".length + 3 + ("newest fact".length + 3);
		expect(fitMemoriesToBudget(texts, budget)).toEqual({ included: [1, 2], omitted: 1 });
	});

	it("still sends one fact alone, however long it is", () => {
		const texts = ["x".repeat(MEMORY_BLOCK_MAX_CHARS + 100)];
		expect(fitMemoriesToBudget(texts)).toEqual({ included: [0], omitted: 0 });
	});

	it("returns the survivors in chronological order, not fill order", () => {
		const texts = ["a".repeat(50), "b".repeat(50), "c".repeat(50), "d".repeat(50)];
		// Room for three: filling runs backwards but the answer reads forwards.
		const budget = 3 * (50 + 3);
		const { included, omitted } = fitMemoriesToBudget(texts, budget);
		expect(included).toEqual([1, 2, 3]);
		expect([...included].sort((x, y) => x - y)).toEqual(included);
		expect(omitted).toBe(1);
	});

	it("is empty on an empty list", () => {
		expect(fitMemoriesToBudget([])).toEqual({ included: [], omitted: 0 });
	});
});
