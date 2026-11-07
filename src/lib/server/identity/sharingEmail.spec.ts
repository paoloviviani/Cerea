import { describe, expect, it } from "vitest";
import { sharingEmail } from "./sharingEmail";

describe("sharingEmail (audit: email_verified for sharing)", () => {
	it.each([
		["a verified address", { email: "a@corp.com", emailVerified: true }, "a@corp.com"],
		["an issuer that sends no claim", { email: "a@corp.com" }, "a@corp.com"],
		[
			"an address the issuer calls unverified",
			{ email: "a@corp.com", emailVerified: false },
			undefined,
		],
		["no address", { emailVerified: true }, undefined],
	])("%s", (_name, user, expected) => {
		expect(sharingEmail(user)).toBe(expected);
	});

	it("no user", () => expect(sharingEmail(undefined)).toBeUndefined());
});

describe("viewerPrincipals uses it", () => {
	it("leaves an unverified address out of the principals", async () => {
		const { viewerPrincipals } = await import("$lib/server/projects");
		const base = { _id: undefined, name: "n", hfUserId: "h", avatarUrl: undefined } as never;
		const verified = await viewerPrincipals(
			{ ...(base as object), email: "A@Corp.com" } as never,
			undefined
		);
		expect(verified.email).toBe("a@corp.com");
		const unverified = await viewerPrincipals(
			{ ...(base as object), email: "A@Corp.com", emailVerified: false } as never,
			undefined
		);
		expect(unverified.email).toBeUndefined();
	});
});
