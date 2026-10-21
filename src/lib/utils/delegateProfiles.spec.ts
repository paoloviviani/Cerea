import { describe, expect, it } from "vitest";
import {
	delegateProfilesSupport,
	PROFILES_OFFLINE_DETAIL,
	PROFILES_TOO_OLD_DETAIL,
	PROFILES_TOOLS_OFF_DETAIL,
} from "./delegateProfiles";

describe("delegateProfilesSupport", () => {
	it("is ok for an online machine whose hello says delegateProfiles", () => {
		expect(
			delegateProfilesSupport({
				online: true,
				machine: { capabilities: { delegateProfiles: true } },
			})
		).toEqual({ ok: true });
	});

	it("says to update galopin when the capability is absent, false or null", () => {
		for (const machine of [
			undefined,
			null,
			{ capabilities: {} },
			{ capabilities: { delegateProfiles: false } },
			{ capabilities: { delegateProfiles: null } },
		]) {
			const got = delegateProfilesSupport({ online: true, machine });
			expect(got).toEqual({ ok: false, reason: "too-old", detail: PROFILES_TOO_OLD_DETAIL });
		}
		expect(PROFILES_TOO_OLD_DETAIL).toContain("update galopin on this machine");
	});

	it("says offline before anything else", () => {
		expect(
			delegateProfilesSupport({
				online: false,
				machine: { capabilities: { delegateProfiles: true } },
			})
		).toEqual({ ok: false, reason: "offline", detail: PROFILES_OFFLINE_DETAIL });
	});

	it("says agent tools are off rather than asking for an update that would not help", () => {
		expect(
			delegateProfilesSupport({
				online: true,
				machine: { capabilities: {} },
				policy: { agentTools: "denied" },
			})
		).toEqual({ ok: false, reason: "tools-off", detail: PROFILES_TOOLS_OFF_DETAIL });
	});
});
