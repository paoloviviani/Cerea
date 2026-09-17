import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { collections, ready } from "$lib/server/database";
import { createTestUser, cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { POST as legacySettingsPOST } from "./+server";

/**
 * The client settings store saves through THIS route (`POST /settings`),
 * not the v2 API. A field added only to the v2 schema is silently stripped
 * here by zod and never persists — which is how `webFetchPolicy` shipped
 * without ever reaching Mongo. This pins the save path it actually takes.
 */
beforeAll(async () => {
	await ready;
}, 30000);

describe("POST /settings (legacy save path)", () => {
	beforeEach(async () => {
		await cleanupTestData();
	}, 20000);

	it("persists webFetchPolicy instead of stripping it", async () => {
		const { user, locals } = await createTestUser();

		const res = await testRequest(legacySettingsPOST, {
			path: "/settings",
			locals,
			method: "POST",
			body: JSON.stringify({ activeModel: "test-model", webFetchPolicy: "ask-domain" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);

		const stored = await collections.settings.findOne({ userId: user._id });
		expect(stored?.webFetchPolicy).toBe("ask-domain");
	});

	it("rejects an unknown policy value", async () => {
		const { locals } = await createTestUser();

		await expect(
			testRequest(legacySettingsPOST, {
				path: "/settings",
				locals,
				method: "POST",
				body: JSON.stringify({ activeModel: "test-model", webFetchPolicy: "prove-it-later" }),
				headers: { "Content-Type": "application/json" },
			})
		).rejects.toThrow();
	});
});
