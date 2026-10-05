import { describe, expect, it } from "vitest";
import { webSearchUnavailableReason } from "./webSearchAvailability";

describe("webSearchUnavailableReason", () => {
	it("offers the switch when a backend is granted or the field is absent", () => {
		expect(webSearchUnavailableReason({ webSearchAvailable: true })).toBeNull();
		expect(webSearchUnavailableReason({})).toBeNull();
	});

	it("says it is not set up, and tells only admins where to fix it", () => {
		expect(webSearchUnavailableReason({ webSearchAvailable: false })).toBe(
			"Web search isn't set up on this deployment."
		);
		expect(
			webSearchUnavailableReason({ webSearchAvailable: false, gatewayIsAdmin: true })
		).toContain("Admin → Web search");
	});
});
