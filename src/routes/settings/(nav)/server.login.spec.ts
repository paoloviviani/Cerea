import { beforeAll, describe, expect, it, vi } from "vitest";

// Sign-in configured: an anonymous write must not mint a settings row (audit M2).
vi.mock("$lib/server/auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/auth")>()),
	loginEnabled: true,
}));

const db = await import("$lib/server/database");
const { ready } = db;
const { cleanupTestData } = await import("$lib/server/api/__tests__/testHelpers");
const { POST } = await import("./+server");

beforeAll(async () => {
	await ready;
	await cleanupTestData();
}, 30000);

describe("POST /settings with sign-in configured", () => {
	it("writes no row for a request with no signed-in user", async () => {
		const before = await db.collections.settings.countDocuments({});
		// Straight at the handler: the wall in front of it is covered by loginWall.spec.ts,
		// and this is the second line of defence.
		const res = await Promise.resolve(
			POST({
				request: new Request("http://localhost/settings", {
					method: "POST",
					body: JSON.stringify({ activeModel: "x" }),
					headers: { "Content-Type": "application/json" },
				}),
				locals: { sessionId: "anon-session" },
			} as never)
		).catch((e: { status?: number }) => e);
		expect(res.status).toBe(401);
		expect(await db.collections.settings.countDocuments({})).toBe(before);
	});
});
