import { describe, expect, it } from "vitest";
import { classifyGatewayError, quotaMessageForUser, quotaNoticeForModel } from "./gatewayErrors";

const quotaBody = {
	message: "Quota exceeded. group per member limit of 5 cost per month exceeded (current 5)",
	type: "insufficient_quota",
	param: null,
	code: "quota_exceeded",
};

describe("classifyGatewayError", () => {
	it("reads quota from an OpenAI SDK error", () => {
		const err = Object.assign(new Error(`429 ${quotaBody.message}`), {
			status: 429,
			code: "quota_exceeded",
			error: quotaBody,
			headers: new Headers({ "retry-after": "7200" }),
		});
		expect(classifyGatewayError(err)).toEqual({
			kind: "quota",
			detail: "group per member limit of 5 cost per month exceeded (current 5)",
			scope: "group",
			retryAfterSeconds: 7200,
		});
	});

	it("reads quota from a GatewayCallFailed-shaped error and from a nested body", () => {
		expect(
			classifyGatewayError(Object.assign(new Error("x"), { status: 429, code: "quota_exceeded" }))
				.kind
		).toBe("quota");
		expect(classifyGatewayError({ status: 429, error: { error: quotaBody } }).kind).toBe("quota");
	});

	it("survives null fields", () => {
		const out = classifyGatewayError({
			status: 429,
			code: null,
			headers: null,
			error: { message: null, type: null, param: null, code: "quota_exceeded" },
		});
		expect(out).toEqual({ kind: "quota", detail: null, scope: null, retryAfterSeconds: null });
	});

	it("falls back to the message when only it survived", () => {
		expect(
			classifyGatewayError({ status: 429, message: "429 Quota exceeded. user limit" }).kind
		).toBe("quota");
	});

	it("a plain 429 is a rate limit, anything else is other", () => {
		expect(classifyGatewayError({ status: 429, code: null, error: { code: null } })).toEqual({
			kind: "rate_limit",
		});
		expect(classifyGatewayError(new Error("HTTP 429 too many"))).toEqual({ kind: "rate_limit" });
		expect(classifyGatewayError({ status: 500 })).toEqual({ kind: "other" });
		expect(classifyGatewayError(null)).toEqual({ kind: "other" });
	});
});

describe("quota wording", () => {
	const group = {
		kind: "quota",
		detail: "group per member limit of 5",
		scope: "group",
		retryAfterSeconds: 7200,
	} as const;
	it("tells the user whose quota, the detail, the reset and where to look", () => {
		const text = quotaMessageForUser(group);
		expect(text).toContain("Your group has reached its usage quota.");
		expect(text).toContain("group per member limit of 5");
		expect(text).toContain("2 h");
		expect(text).toContain("Settings → Usage & billing");
		expect(
			quotaMessageForUser({ ...group, scope: "user", detail: null, retryAfterSeconds: null })
		).toBe("You've reached your usage quota. See Settings → Usage & billing.");
	});
	it("tells the model not to retry", () => {
		expect(quotaNoticeForModel(group)).toContain("Do not retry or delegate again");
	});
});
