import { describe, expect, it } from "vitest";
import { webSearchUnavailableReason } from "./webSearchAvailability";

describe("webSearchUnavailableReason", () => {
	it("offers the switch when a backend is granted or the field is absent", () => {
		expect(webSearchUnavailableReason({ webSearchAvailable: true })).toBeNull();
		expect(webSearchUnavailableReason({})).toBeNull();
	});

	it("says a model without tools cannot search, after the backend reason", () => {
		expect(
			webSearchUnavailableReason({ webSearchAvailable: true, modelSupportsTools: false })
		).toBe(
			"This model cannot use tools, so it cannot search the web. Pick a model that supports tools."
		);
		expect(webSearchUnavailableReason({ modelSupportsTools: true })).toBeNull();
		expect(
			webSearchUnavailableReason({ webSearchAvailable: false, modelSupportsTools: false })
		).toBe("Web search isn't set up here yet.");
	});

	it("says it is not set up, and tells only admins where to fix it", () => {
		expect(webSearchUnavailableReason({ webSearchAvailable: false })).toBe(
			"Web search isn't set up here yet."
		);
		expect(
			webSearchUnavailableReason({ webSearchAvailable: false, gatewayIsAdmin: true })
		).toContain("Admin → Web search");
	});
});
