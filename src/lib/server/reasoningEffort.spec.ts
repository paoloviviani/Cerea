import { describe, it, expect } from "vitest";

import { effectiveReasoningEffort } from "./reasoningEffort";

describe("effectiveReasoningEffort", () => {
	const settings = { reasoningEffortOverrides: { "org/m": "medium" as const } };

	it("uses the conversation's own effort over the user's default", () => {
		expect(effectiveReasoningEffort({ reasoningEffort: "low" }, settings, "org/m")).toBe("low");
	});

	it("falls back to the user's per-model default, then to none", () => {
		expect(effectiveReasoningEffort({}, settings, "org/m")).toBe("medium");
		expect(effectiveReasoningEffort({}, settings, "org/other")).toBeUndefined();
		expect(effectiveReasoningEffort({}, null, "org/m")).toBeUndefined();
	});
});
