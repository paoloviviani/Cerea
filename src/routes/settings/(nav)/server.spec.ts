import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { collections, ready } from "$lib/server/database";
import { createTestUser, cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { POST as legacySettingsPOST } from "./+server";

/**
 * The client settings store saves through THIS route (`POST /settings`),
 * not the v2 API. A field added only to the v2 schema is silently stripped
 * here by zod and never persists — which is how the previous fetch policy
 * shipped without ever reaching Mongo. This pins the save path it actually
 * takes.
 */
beforeAll(async () => {
	await ready;
}, 30000);

describe("POST /settings (legacy save path)", () => {
	beforeEach(async () => {
		await cleanupTestData();
	}, 20000);

	it("persists toolApprovalPolicy instead of stripping it", async () => {
		const { user, locals } = await createTestUser();

		const res = await testRequest(legacySettingsPOST, {
			path: "/settings",
			locals,
			method: "POST",
			body: JSON.stringify({ activeModel: "test-model", toolApprovalPolicy: "always-allow" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);

		const stored = await collections.settings.findOne({ userId: user._id });
		expect(stored?.toolApprovalPolicy).toBe("always-allow");
	});

	it("rejects an unknown policy value", async () => {
		const { locals } = await createTestUser();

		await expect(
			testRequest(legacySettingsPOST, {
				path: "/settings",
				locals,
				method: "POST",
				body: JSON.stringify({ activeModel: "test-model", toolApprovalPolicy: "prove-it-later" }),
				headers: { "Content-Type": "application/json" },
			})
		).rejects.toThrow();
	});

	it("persists the location mode and a sanitised place (the client's save path)", async () => {
		const { user, locals } = await createTestUser();
		const post = (body: unknown) =>
			testRequest(legacySettingsPOST, {
				path: "/settings",
				locals,
				method: "POST",
				body: JSON.stringify({ activeModel: "test-model", ...(body as object) }),
				headers: { "Content-Type": "application/json" },
			});

		const res = await post({ locationMode: "place", locationPlace: "Torino,\nItaly\u0007" });
		expect(res.status).toBe(200);
		const stored = await collections.settings.findOne({ userId: user._id });
		expect(stored?.locationMode).toBe("place");
		expect(stored?.locationPlace).toBe("Torino, Italy");
		// no coordinates are ever a settings field
		expect(Object.keys(stored ?? {}).filter((k) => /lat|lon|coord/i.test(k))).toEqual([]);
	});

	it("rejects an unknown mode and a place over 100 characters", async () => {
		const { locals } = await createTestUser();
		for (const extra of [{ locationMode: "gps" }, { locationPlace: "x".repeat(101) }]) {
			await expect(
				testRequest(legacySettingsPOST, {
					path: "/settings",
					locals,
					method: "POST",
					body: JSON.stringify({ activeModel: "test-model", ...extra }),
					headers: { "Content-Type": "application/json" },
				})
			).rejects.toThrow();
		}
	});
});
