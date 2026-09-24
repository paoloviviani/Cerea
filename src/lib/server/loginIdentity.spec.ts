import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import type { User } from "$lib/types/User";
import { findLoginUser, IssuerMismatchError } from "./loginIdentity";

function fakeUsers(docs: Partial<User>[]) {
	const rows = docs.map((d) => ({ _id: new ObjectId(), ...d }) as User);
	const matches = (row: User, query: Record<string, unknown>): boolean =>
		Object.entries(query).every(([key, value]) => {
			if (key === "$or") return (value as Record<string, unknown>[]).some((q) => matches(row, q));
			const field = (row as unknown as Record<string, unknown>)[key];
			if (value && typeof value === "object" && "$exists" in value) {
				return (field !== undefined) === (value as { $exists: boolean }).$exists;
			}
			return field === value;
		});
	return {
		rows,
		findOne: async (query: Record<string, unknown>) => rows.find((r) => matches(r, query)) ?? null,
		updateOne: async (query: { _id: ObjectId }, update: { $set: Partial<User> }) => {
			const row = rows.find((r) => r._id.equals(query._id));
			if (row) Object.assign(row, update.$set);
			return { acknowledged: true, matchedCount: row ? 1 : 0 };
		},
	};
}

const ISS = "https://llm.example.org/authelia";

describe("findLoginUser", () => {
	it("adopts the first issuer on a legacy account, then insists on it", async () => {
		const users = fakeUsers([{ hfUserId: "sub-1", email: "a@x.org" }]);
		const found = await findLoginUser(users as never, { sub: "sub-1", issuer: `${ISS}/` });
		expect(found?.issuer).toBe(ISS);
		expect(users.rows[0].issuer).toBe(ISS);
		await expect(
			findLoginUser(users as never, { sub: "sub-1", issuer: "https://other.example.org" })
		).rejects.toBeInstanceOf(IssuerMismatchError);
	});

	it("carries an account across an issuer move by verified email", async () => {
		const users = fakeUsers([
			{ hfUserId: "old-sub", email: "a@x.org", issuer: "https://old.example.org" },
		]);
		const login = {
			sub: "new-sub",
			issuer: ISS,
			email: "a@x.org",
			migrateFrom: "https://old.example.org/",
		};
		expect(await findLoginUser(users as never, { ...login, emailVerified: "true" })).toBeNull();
		const moved = await findLoginUser(users as never, { ...login, emailVerified: true });
		expect(moved?.hfUserId).toBe("new-sub");
		expect(users.rows[0]).toMatchObject({
			hfUserId: "new-sub",
			issuer: ISS,
			migratedFromSub: "old-sub",
		});
	});

	it("does not migrate without the switch", async () => {
		const users = fakeUsers([
			{ hfUserId: "old-sub", email: "a@x.org", issuer: "https://old.example.org" },
		]);
		expect(
			await findLoginUser(users as never, {
				sub: "new-sub",
				issuer: ISS,
				email: "a@x.org",
				emailVerified: true,
			})
		).toBeNull();
	});
});
