/** Account-scoped JSON answers carry `Cache-Control: no-store` (audit L: minted keys, one-time passwords). */
import { beforeAll, describe, expect, it } from "vitest";
import type { RequestHandler } from "@sveltejs/kit";
import { ready } from "$lib/server/database";
import { testRequest } from "$lib/server/__tests__/testRequest";

beforeAll(async () => {
	await ready;
});

const respond =
	(body: string, headers: Record<string, string>): RequestHandler =>
	async () =>
		new Response(body, { status: 200, headers });

describe("no-store on /api JSON", () => {
	it("is added to a JSON answer that set no cache policy", async () => {
		const res = await testRequest(respond("{}", { "content-type": "application/json" }), {
			path: "/api/v2/anything",
			routeId: "/api/v2/anything" as never,
		});
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("keeps a policy the route chose", async () => {
		const res = await testRequest(
			respond("{}", { "content-type": "application/json", "cache-control": "max-age=60" }),
			{ path: "/api/v2/anything", routeId: "/api/v2/anything" as never }
		);
		expect(res.headers.get("cache-control")).toBe("max-age=60");
	});

	it("leaves non-JSON answers (images, fonts) cacheable", async () => {
		const res = await testRequest(respond("x", { "content-type": "image/png" }), {
			path: "/api/v2/anything",
			routeId: "/api/v2/anything" as never,
		});
		expect(res.headers.get("cache-control")).toBeNull();
	});
});
