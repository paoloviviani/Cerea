import { describe, expect, it } from "vitest";
import { resolveToolApprovalPolicy } from "./toolApprovalPolicy";

describe("resolveToolApprovalPolicy (ADR 0075)", () => {
	it("defaults to manual when neither the chat nor the user has an opinion", () => {
		expect(resolveToolApprovalPolicy({}, undefined)).toBe("manual");
		expect(resolveToolApprovalPolicy({}, null)).toBe("manual");
		expect(resolveToolApprovalPolicy({}, {})).toBe("manual");
	});

	it("falls back to the user's setting when the chat has no override", () => {
		expect(resolveToolApprovalPolicy({}, { toolApprovalPolicy: "always-allow" })).toBe(
			"always-allow"
		);
		expect(resolveToolApprovalPolicy({}, { toolApprovalPolicy: "manual" })).toBe("manual");
	});

	it("lets the chat override win in either direction over the user's setting", () => {
		expect(
			resolveToolApprovalPolicy(
				{ toolApprovalOverride: "always-allow" },
				{ toolApprovalPolicy: "manual" }
			)
		).toBe("always-allow");
		expect(
			resolveToolApprovalPolicy(
				{ toolApprovalOverride: "manual" },
				{ toolApprovalPolicy: "always-allow" }
			)
		).toBe("manual");
	});

	it("lets the chat override win even with no user setting at all", () => {
		expect(resolveToolApprovalPolicy({ toolApprovalOverride: "always-allow" }, undefined)).toBe(
			"always-allow"
		);
	});
});
