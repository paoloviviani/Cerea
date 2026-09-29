import { describe, expect, it } from "vitest";
import { attachmentResponse } from "./downloadFile";

/**
 * The download response's hardening headers: `conversation/[id]/output/[sha256]`
 * (message attachments) and the `/code` attachment routes share this one
 * constructor, so the assertions live here rather than per route. The
 * code-execution deliverable route builds the same shape inline (see its
 * +server.ts) — kept in step by hand, asserted by reading, since spinning
 * that route needs a conversation row.
 */
describe("attachmentResponse", () => {
	it("downloads, never renders, with the sandbox CSP and nosniff", () => {
		const sha = "a".repeat(64);
		const res = attachmentResponse(sha, {
			value: Buffer.from("hello").toString("base64"),
			mime: "image/png",
		});
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("content-disposition")).toMatch(
			/^attachment; filename="aaaaaaaa\.png"$/
		);
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-length")).toBe("5");
	});

	it("falls back to an opaque type for untyped bytes", () => {
		const res = attachmentResponse("b".repeat(64), {
			value: Buffer.from("hello").toString("base64"),
		});
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});
});
