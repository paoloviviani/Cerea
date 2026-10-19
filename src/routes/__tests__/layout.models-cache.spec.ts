/**
 * The models cache key carries the billing group.
 *
 * `GET /api/v2/models` is served with `Cache-Control: private, max-age=60`,
 * and the list it returns is the gateway's answer for the request's
 * bill-to (ADR 0061). If the URL did not name the group, changing it in the
 * usage page's selector would invalidate the loads, refetch this exact URL,
 * and the browser would serve the previous group's list for up to a
 * minute. The layout therefore fetches the catalogue with a `bill-to`
 * query parameter taken from the person's stored settings — a different
 * group is a different URL, so the cache misses and the fresh list arrives
 * with the change.
 *
 * Runs the layout's own load against a stub fetch (the same shape every
 * SvelteKit load test uses): settings first — the key comes from them —
 * then the rest in parallel. Asserts the models request's URL carries the
 * stored billing organisation, and a different one without it.
 */
import { describe, expect, it } from "vitest";
import superjson from "superjson";
import type { RequestInfo, RequestInit } from "undici";

const GATEWAY_LINES = [
	{ id: "org/alpha", displayName: "Alpha" },
	{ id: "org/beta", displayName: "Beta" },
];

// The APIClient's endpoints answer in superjson (`handleResponse` parses
// that envelope); the layout's own `fetch` calls read plain JSON.
function respondSuperjson(body: unknown): Response {
	return new Response(superjson.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function respondRaw(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function stubFor(settings: Record<string, unknown>, requests: { url: string }[]) {
	return (async (info: RequestInfo, _init?: RequestInit) => {
		const url = typeof info === "string" ? info : info.toString();
		requests.push({ url });
		if (url.includes("/api/v2/user/settings")) return respondSuperjson(settings);
		if (url.includes("/api/v2/models")) {
			return respondSuperjson(GATEWAY_LINES);
		}
		if (url.includes("/api/v2/conversations")) {
			return respondSuperjson({ conversations: [], hasMore: false });
		}
		if (url.includes("/api/mcp/servers")) return respondRaw([]);
		if (url.includes("/api/v2/custom-models")) return respondRaw({ data: { models: [] } });
		// public-config, feature-flags, user
		return respondSuperjson({});
	}) as unknown as typeof fetch;
}

const loadParams = (fetchImpl: typeof fetch) => ({
	fetch: fetchImpl,
	url: new URL("http://localhost:5173/chat/"),
	// +layout.server.ts's fields the universal load re-returns.
	data: {
		gatewayIsAdmin: false,
		webSearchAvailable: false,
		codeFilesEnabled: false,
		codeTerminalEnabled: false,
		codeSchedulesEnabled: false,
	},
	state: {},
	path: "",
});

describe("+layout.ts caches the model list per billing group", () => {
	it("fetches the catalogue with bill-to set to the person's chosen group", async () => {
		const requests: { url: string }[] = [];
		const fetchImpl = stubFor({ activeModel: "org/alpha", billingOrganization: "beta" }, requests);

		const { load } = await import("../+layout");
		await load(loadParams(fetchImpl) as unknown as Parameters<typeof load>[0]);

		const modelsRequest = requests.find((r) => r.url.includes("/api/v2/models"));
		expect(modelsRequest).toBeDefined();
		expect(modelsRequest?.url).toContain("bill-to=beta");
	});

	it("fetches the catalogue with an empty bill-to when no group is chosen", async () => {
		const requests: { url: string }[] = [];
		const fetchImpl = stubFor({ activeModel: "org/alpha" }, requests);

		const { load } = await import("../+layout");
		await load(loadParams(fetchImpl) as unknown as Parameters<typeof load>[0]);

		const modelsRequest = requests.find((r) => r.url.includes("/api/v2/models"));
		expect(modelsRequest).toBeDefined();
		expect(modelsRequest?.url).toContain("bill-to=");
		expect(modelsRequest?.url).not.toMatch(/bill-to=[^&]/);
	});
});
