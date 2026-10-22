/**
 * The login wall (`hooks/handle.ts`) is deny-by-default: with a sign-in
 * configured, a signed-out request is refused unless its route is on
 * `SIGNED_OUT_GET_ROUTES` (reads) or is one of the wall's named exemptions.
 *
 * This is the spec that must FAIL when a route is added without being thought
 * about. It walks the real route tree and, for every route that answers GET,
 * sends a signed-out request through the real hook with a stub handler behind
 * it: a route that is not on the allow-list must be refused (401, or a redirect
 * to sign-in for a page) and the stub must never run. It also fails on an
 * allow-list entry that names no route, so the list cannot rot.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RequestHandler } from "@sveltejs/kit";

vi.mock("$lib/server/auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/auth")>()),
	loginEnabled: true,
	// The real one runs OIDC discovery over the network; what matters here is
	// only that the wall sent the page to sign-in instead of to its handler.
	triggerOauthFlow: async () =>
		new Response(null, { status: 302, headers: { location: "https://idp.invalid/authorize" } }),
}));

const { testRequest } = await import("$lib/server/__tests__/testRequest");
const { SIGNED_OUT_GET_ROUTES } = await import("./handle");
const { collections, ready } = await import("$lib/server/database");
const { createTestUser, cleanupTestData } = await import("$lib/server/api/__tests__/testHelpers");

const ROUTES_DIR = fileURLToPath(new URL("../../../routes", import.meta.url));

/**
 * Routes the wall lets through for every method because they authenticate
 * themselves (or sign a person in or out), so they are not on the GET list.
 */
const WALL_EXEMPT: Record<string, string> = {
	"/login": "starts the sign-in",
	"/login/callback": "finishes the sign-in",
	"/logout": "ends the session; refusing it would refuse the clean-up",
	"/admin/stats/compute": "machine endpoint, static bearer secret checked in the hook",
	"/internal/erasure": "gateway service call, static bearer checked by the route",
	"/internal/erasure/preview": "gateway service call, static bearer checked by the route",
};

interface DiscoveredRoute {
	id: string;
	path: string;
}

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

/** Every route id that answers GET: a +page.* file, or a +server.ts exporting GET. */
function discoverGetRoutes(): DiscoveredRoute[] {
	const ids = new Set<string>();
	for (const file of walk(ROUTES_DIR)) {
		const name = file.split(sep).pop() ?? "";
		const isPage = /^\+page(\.server)?\.ts$|^\+page\.svelte$/.test(name);
		const isGetServer =
			name === "+server.ts" &&
			/export\s+(?:const|async\s+function|function)\s+GET\b|export\s*\{[^}]*\bGET\b/.test(
				readFileSync(file, "utf8")
			);
		if (!isPage && !isGetServer) continue;
		const segments = relative(ROUTES_DIR, join(file, ".."))
			.split(sep)
			.filter((s) => s && !/^\(.*\)$/.test(s));
		ids.add("/" + segments.join("/"));
	}
	return [...ids].sort().map((id) => ({
		id,
		path: id.replace(/\[\.\.\.[^\]]+\]/g, "a/b").replace(/\[[^\]]+\]/g, "x1"),
	}));
}

const routes = discoverGetRoutes();

function stub(calls: string[]): RequestHandler {
	return async ({ url }) => {
		calls.push(url.pathname);
		return new Response("handler ran", { status: 200 });
	};
}

beforeAll(async () => {
	await ready;
});

afterAll(async () => {
	await cleanupTestData();
});

describe("login wall: route tree", () => {
	it("finds the route tree", () => {
		expect(routes.length).toBeGreaterThan(50);
	});

	it("every allow-list entry names a route that answers GET", () => {
		const ids = new Set(routes.map((r) => r.id));
		const stale = [...SIGNED_OUT_GET_ROUTES.keys()].filter((id) => !ids.has(id));
		expect(stale).toEqual([]);
	});

	it("every allow-list entry carries a reason", () => {
		for (const [id, why] of SIGNED_OUT_GET_ROUTES) expect(why.length, id).toBeGreaterThan(10);
	});

	for (const route of routes) {
		if (route.id in WALL_EXEMPT) continue;
		const allowed = SIGNED_OUT_GET_ROUTES.has(route.id);

		it(`${allowed ? "serves" : "refuses"} signed-out GET ${route.id}`, async () => {
			const calls: string[] = [];
			const res = await testRequest(stub(calls), {
				path: route.path,
				routeId: route.id,
				headers: { accept: route.id.startsWith("/api/") ? "*/*" : "text/html" },
			});

			if (allowed) {
				expect(calls).toHaveLength(1);
				expect(res.status).toBe(200);
			} else {
				expect(calls, "the handler must not run").toEqual([]);
				expect([401, 302]).toContain(res.status);
				if (route.id.startsWith("/api/")) {
					expect(res.status).toBe(401);
					expect(res.headers.get("content-type")).toContain("application/json");
				}
			}
		});
	}
});

describe("login wall: other methods and signed-in use", () => {
	it("still refuses a signed-out POST", async () => {
		const calls: string[] = [];
		const res = await testRequest(stub(calls), {
			path: "/api/v2/custom-models",
			routeId: "/api/v2/custom-models",
			method: "POST",
			body: "{}",
			headers: { "content-type": "application/json", "content-length": "2" },
		});
		expect(res.status).toBe(401);
		expect(calls).toEqual([]);
	});

	it("refuses an unmatched path (no route id) rather than serving it", async () => {
		const calls: string[] = [];
		const res = await testRequest(stub(calls), { path: "/api/v2/not-a-route" });
		expect(res.status).toBe(401);
		expect(calls).toEqual([]);
	});

	it("lets a signed-in session reach every route the wall refuses to a stranger", async () => {
		const { cookie } = await createTestUser();
		for (const route of routes) {
			if (route.id in WALL_EXEMPT) continue;
			// A different guard (the 7-day stale-session check, stale-guard.spec.ts)
			// answers for this prefix; the test session has no sign-in time.
			if (route.id.startsWith("/api/v2/code/") && route.id !== "/api/v2/code/status") continue;
			const calls: string[] = [];
			const res = await testRequest(stub(calls), {
				path: route.path,
				routeId: route.id,
				headers: { cookie },
			});
			expect(res.status, route.id).toBe(200);
			expect(calls, route.id).toHaveLength(1);
		}
		expect(collections.sessions).toBeDefined();
	});
});
