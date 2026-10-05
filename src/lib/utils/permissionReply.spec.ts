import { describe, expect, it } from "vitest";
import { ALREADY_ANSWERED_NOTE, isAlreadyAnswered, replyOutcome } from "./permissionReply";

describe("a reply to an ask that is already gone", () => {
	const raw = new Error(
		'opencode POST /permission/per_1/reply?directory=%2Fhome%2Fubuntu: status 404 {"_tag":"PermissionNotFoundError"}'
	);

	it("is resolved, with a short note, never the raw error", () => {
		expect(isAlreadyAnswered(raw)).toBe(true);
		expect(replyOutcome(raw, "x")).toEqual({ ok: true, note: ALREADY_ANSWERED_NOTE });
	});

	it("leaves other failures as errors", () => {
		expect(replyOutcome(new Error("device offline"), "x")).toEqual({
			ok: false,
			error: "device offline",
		});
		expect(replyOutcome("nope", "fallback")).toEqual({ ok: false, error: "fallback" });
	});
});
