/**
 * `findLoginUser`'s §4.5 fixes against a real MongoDB collection — the
 * `previousIdentities` dot-notation match and the `$push` that populates it
 * only work against a real driver, not the plain-object test double in
 * `loginIdentity.spec.ts` (see the comment on that file's `fakeUsers`).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { findLoginUser } from "./loginIdentity";

describe("findLoginUser against real Mongo (ADR 0093 §4.5)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("matches the migration by normalised email equality", async () => {
		const { insertedId } = await collections.users.insertOne({
			_id: new ObjectId(),
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "Person",
			hfUserId: "old-sub-1",
			issuer: "https://old.example.org",
			email: "Person@Example.ORG",
			emailNormalized: "person@example.org",
		} as never);

		const moved = await findLoginUser(collections.users, {
			sub: "new-sub-1",
			issuer: "https://new.example.org",
			email: "person@EXAMPLE.org",
			emailVerified: true,
			migrateFrom: "https://old.example.org",
		});

		expect(moved?._id.equals(insertedId)).toBe(true);
		const reloaded = await collections.users.findOne({ _id: insertedId });
		expect(reloaded?.hfUserId).toBe("new-sub-1");
		expect(reloaded?.previousIdentities).toMatchObject([
			{ issuer: "https://old.example.org", sub: "old-sub-1" },
		]);

		await collections.users.deleteOne({ _id: insertedId });
	});

	it("finds the account again on a second hop back, via previousIdentities", async () => {
		const { insertedId } = await collections.users.insertOne({
			_id: new ObjectId(),
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "Person",
			hfUserId: "sub-b",
			issuer: "https://b.example.org",
			email: "hop@example.org",
			emailNormalized: "hop@example.org",
			previousIdentities: [{ issuer: "https://a.example.org", sub: "sub-a", at: new Date() }],
		} as never);

		// A → B → C already happened; now the deployment switches straight back
		// to A. The account's *current* issuer is C by the time this runs, but
		// its very first identity (A, sub-a) is still in `previousIdentities`.
		await collections.users.updateOne(
			{ _id: insertedId },
			{ $set: { hfUserId: "sub-c", issuer: "https://c.example.org" } }
		);

		const moved = await findLoginUser(collections.users, {
			sub: "sub-a-again",
			issuer: "https://a.example.org",
			email: "hop@example.org",
			emailVerified: true,
			migrateFrom: "https://a.example.org",
		});

		expect(moved?._id.equals(insertedId)).toBe(true);

		await collections.users.deleteOne({ _id: insertedId });
	});
});
