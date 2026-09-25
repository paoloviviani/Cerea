import { describe, it, expect, vi } from "vitest";

// The preset is a build flag; forced on so its branch is reachable.
vi.mock("$lib/utils/mlAssistantFlag", () => ({ ML_ASSISTANT_MODE: true }));
const { effectiveReasoningEffort } = await import("./reasoningEffort");

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

	it("lets the ML Assistant preset pin its own", () => {
		expect(
			effectiveReasoningEffort({ mlAssistant: true, reasoningEffort: "low" }, settings, "org/m")
		).toBe("high");
	});
});
