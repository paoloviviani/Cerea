import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config", () => ({
	config: { CHAT_ERASURE_TOKEN: "correct-horse-battery-staple" },
}));

const { assertInternalRequest } = await import("./internalAuth");

function req(headers: Record<string, string>): Request {
	return new Request("http://internal.invalid/internal/erasure", { headers });
}

/** `error(status, message)` throws a plain `{status, body}` object, not an
 * `Error` — asserted on `.status` directly, the same pattern
 * `attachmentStore.spec.ts` uses for its own `error()`-throwing calls. */
function expectRefused(fn: () => void, status: number): void {
	try {
		fn();
		expect.fail("expected assertInternalRequest to refuse the request");
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("assertInternalRequest (ADR 0093 §9.3)", () => {
	it("accepts the configured token", () => {
		expect(() =>
			assertInternalRequest(req({ authorization: "Bearer correct-horse-battery-staple" }))
		).not.toThrow();
	});

	it("refuses a missing token", () => {
		expectRefused(() => assertInternalRequest(req({})), 401);
	});

	it("refuses a wrong token", () => {
		expectRefused(
			() => assertInternalRequest(req({ authorization: "Bearer some-other-token" })),
			401
		);
	});

	it.each(["x-forwarded-for", "x-forwarded-host", "forwarded"])(
		"refuses any request carrying %s, even with the right token",
		(header) => {
			expectRefused(
				() =>
					assertInternalRequest(
						req({ authorization: "Bearer correct-horse-battery-staple", [header]: "1.2.3.4" })
					),
				401
			);
		}
	);
});
