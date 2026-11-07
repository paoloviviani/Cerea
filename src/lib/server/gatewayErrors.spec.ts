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
			figures: { metric: "cost", limit: 5, current: 5, window: "month" },
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
		expect(out).toEqual({
			kind: "quota",
			detail: null,
			scope: null,
			retryAfterSeconds: null,
			figures: null,
		});
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
	const gatewayBody = {
		status: 429,
		error: {
			code: "quota_exceeded",
			message: "Quota exceeded. user limit of 0E-12 cost per month exceeded (current 0)",
		},
		headers: { "retry-after": String(24 * 86400) },
	};
	const now = new Date("2026-11-07T10:00:00Z");

	it("parses the figures out of the gateway's message", () => {
		const f = classifyGatewayError(gatewayBody);
		expect(f).toMatchObject({
			kind: "quota",
			figures: { metric: "cost", limit: 0, current: 0, window: "month" },
		});
	});

	it('says it in a sentence, with no "used up" for a limit of zero: no scientific notation, no gateway text', () => {
		const f = classifyGatewayError(gatewayBody);
		if (f.kind !== "quota") throw new Error("expected quota");
		const text = quotaMessageForUser(f, { currency: "EUR", usageEnabled: true, now });
		expect(text).toBe("You don't have an allowance for this. Ask your administrator.");
		expect(text).not.toContain("0E-12");
		expect(text).not.toContain("current");
	});

	it("formats a real limit and leaves out the Usage link when there is no tab", () => {
		const f = classifyGatewayError({
			...gatewayBody,
			error: {
				code: "quota_exceeded",
				message:
					"Quota exceeded. group per member limit of 10.00 cost per month exceeded (current 10.0030)",
			},
			headers: { "retry-after": "7200" },
		});
		if (f.kind !== "quota") throw new Error("expected quota");
		const text = quotaMessageForUser(f, { currency: "EUR", now });
		expect(text).toBe(
			"Your group's monthly allowance of €10.00 is used up. Ask your administrator."
		);
	});

	it("handles a count metric and an unparsed message", () => {
		const f = classifyGatewayError({
			code: "quota_exceeded",
			message: "Quota exceeded. user limit of 1000 requests per day exceeded (current 1000)",
		});
		if (f.kind !== "quota") throw new Error("expected quota");
		expect(quotaMessageForUser(f)).toContain("Your daily allowance of 1,000 requests is used up.");
		expect(
			quotaMessageForUser({
				kind: "quota",
				detail: null,
				scope: null,
				retryAfterSeconds: null,
				figures: null,
			})
		).toBe("You've used up your allowance. Ask your administrator.");
	});

	it("tells the model not to retry", () => {
		const f = classifyGatewayError(gatewayBody);
		if (f.kind !== "quota") throw new Error("expected quota");
		expect(quotaNoticeForModel(f)).toContain("Do not retry or delegate again");
	});
});
