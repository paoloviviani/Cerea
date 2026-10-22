/**
 * With no sign-in configured (`loginEnabled === false`) the wall is not
 * armed at all: anonymous use is the deployment's mode, so a route that is not
 * on the signed-out allow-list is still served. Companion to `loginWall.spec.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { RequestHandler } from "@sveltejs/kit";
import { loginEnabled } from "$lib/server/auth";
import { ready } from "$lib/server/database";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { SIGNED_OUT_GET_ROUTES } from "./handle";

beforeAll(async () => {
	await ready;
});

describe("login wall: login not enabled", () => {
	it("serves reads and writes outside the allow-list to an anonymous session", async () => {
		expect(loginEnabled).toBe(false);
		expect(SIGNED_OUT_GET_ROUTES.has("/api/fetch-url")).toBe(false);

		const ok: RequestHandler = async () => new Response("ok", { status: 200 });
		const get = await testRequest(ok, { path: "/api/fetch-url", routeId: "/api/fetch-url" });
		expect(get.status).toBe(200);

		const post = await testRequest(ok, {
			path: "/api/v2/custom-models",
			routeId: "/api/v2/custom-models",
			method: "POST",
			body: "{}",
			headers: { "content-type": "application/json", "content-length": "2" },
		});
		expect(post.status).toBe(200);
	});
});
