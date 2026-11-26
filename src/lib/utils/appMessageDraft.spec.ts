import { describe, expect, it } from "vitest";
import { APP_SUGGESTION_INTERVAL_MS, createSuggestionGate } from "./appMessageDraft";

describe("the suggestion gate", () => {
	it("allows one suggestion per interval and counts only the ones it allows", () => {
		let now = 1_000_000;
		const allowed = createSuggestionGate(() => now);

		expect(allowed()).toBe(true);
		now += APP_SUGGESTION_INTERVAL_MS - 1;
		expect(allowed()).toBe(false);
		// A refused attempt does not push the next window away.
		now += 1;
		expect(allowed()).toBe(true);
	});
});
