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

describe("a row from before the claim was stored (stale emailVerified)", () => {
	it("is trusted where the issuer never sends the claim, unproven where it does", async () => {
		const { sharingEmailFor, _resetIssuerClaimCache } = await import("./sharingEmail");
		const { collections, ready } = await import("$lib/server/database");
		await ready;
		const issuer = `https://idp-${Date.now()}.example`;
		const stale = { email: "a@corp.com", issuer } as never;
		_resetIssuerClaimCache();
		expect(await sharingEmailFor(stale)).toBe("a@corp.com");
		await collections.users.insertOne({
			name: "n",
			hfUserId: `h-${issuer}`,
			issuer,
			emailVerified: true,
			avatarUrl: undefined,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		_resetIssuerClaimCache();
		expect(await sharingEmailFor(stale)).toBeUndefined();
		expect(await sharingEmailFor({ ...(stale as object), emailVerified: true } as never)).toBe(
			"a@corp.com"
		);
		await collections.users.deleteMany({ issuer });
	});
});
