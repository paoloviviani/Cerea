import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import superjson from "superjson";
import { collections, ready } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { createTestUser, cleanupTestData } from "./testHelpers";
import { GET, POST } from "../../../../routes/api/v2/user/settings/+server";

function getEvent(locals: App.Locals) {
	return {
		locals,
		url: new URL("http://localhost/api/v2/user/settings"),
		request: new Request("http://localhost/api/v2/user/settings"),
	} as Parameters<typeof GET>[0];
}

function postEvent(locals: App.Locals, body: string) {
	return {
		locals,
		url: new URL("http://localhost/api/v2/user/settings"),
		request: new Request("http://localhost/api/v2/user/settings", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		}),
	} as Parameters<typeof POST>[0];
}

// `collections` is undefined until the database IIFE resolves.
beforeAll(async () => {
	await ready;
});

describe("POST /api/v2/user/settings", () => {
	beforeEach(async () => {
		await cleanupTestData();
		await collections.settings.deleteMany({});
	}, 20000);

	it("answers 400, not 500, for a body that fails validation", async () => {
		const { locals } = await createTestUser();
		const res = await POST(postEvent(locals, JSON.stringify({ directPaste: "yes" })));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { issues: Array<{ path: string[] }> };
		expect(body.issues[0].path).toEqual(["directPaste"]);
	});

	it("answers 400 for a body that is not a JSON object", async () => {
		const { locals } = await createTestUser();
		expect((await POST(postEvent(locals, "not json"))).status).toBe(400);
		expect((await POST(postEvent(locals, "[1]"))).status).toBe(400);
	});

	it("takes GET's own output back: its nulls mean unset", async () => {
		const { locals } = await createTestUser();
		// GET's plain JSON (what a script reads) reports unset fields as null.
		const got = superjson.parse<Record<string, unknown>>(
			await (await GET(getEvent(locals))).text()
		);
		const plain = JSON.parse(JSON.stringify(got, (_k, v) => (v === undefined ? null : v)));
		expect(Object.values(plain)).toContain(null);

		const res = await POST(postEvent(locals, JSON.stringify({ ...plain, directPaste: true })));
		expect(res.status).toBe(200);
		const stored = await collections.settings.findOne(authCondition(locals));
		expect(stored?.directPaste).toBe(true);
		// A null never lands in the store as a value.
		expect(Object.entries(stored ?? {}).filter(([, v]) => v === null)).toEqual([]);
	});
});
