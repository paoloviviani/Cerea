import { describe, expect, it } from "vitest";
import { approvalStateFor, resolveToolApprovalPolicy } from "./toolApprovalPolicy";

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

describe("approvalStateFor", () => {
	const approved = ["hf:do_thing"];

	it("makes an Ask scheduled run manual with nothing pre-approved, whatever the person's policy or grants", () => {
		for (const policy of ["manual", "always-allow"] as const) {
			const state = approvalStateFor({
				scheduledRun: { permissionMode: "ask" },
				policy,
				approvedTools: approved,
			});
			expect(state.policy).toBe("manual");
			expect([...state.approvedTools]).toEqual([]);
		}
	});

	it("leaves an Allow scheduled run, and every other turn, with the person's own policy and grants", () => {
		for (const scheduledRun of [{ permissionMode: "allow" as const }, undefined]) {
			const state = approvalStateFor({
				scheduledRun,
				policy: "always-allow",
				approvedTools: approved,
			});
			expect(state.policy).toBe("always-allow");
			expect([...state.approvedTools]).toEqual(approved);
		}
	});
});
