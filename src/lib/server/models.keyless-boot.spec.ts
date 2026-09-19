/**
 * The boot path Pystino no longer mints a key for (ADR 0081): against a
 * gateway whose `GET /v1/models` answers publicly, `buildModels` must build
 * the catalogue with no `OPENAI_API_KEY`/`HF_TOKEN` configured at all — the
 * `authToken ? { Authorization: ... } : undefined` branch in
 * `src/lib/server/models.ts` already does this, this only confirms it against
 * a stand-in for the public endpoint rather than redesigning it.
 *
 * Isolated in its own file because `models.ts` runs `buildModels()` at module
 * scope: this needs its own `$env/dynamic/*` mocks (no key at all) ahead of
 * that top-level await, which would collide with the fixture-backed catalogue
 * every other spec file shares via `scripts/setups/vitest-setup-server.ts`.
 */
import { describe, expect, it, vi } from "vitest";

const KEYLESS_BASE_URL = "http://keyless-models.test.invalid/v1";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_ORIGIN: "https://vitest.invalid" } }));
vi.mock("$env/dynamic/private", () => ({
	env: {
		OPENAI_BASE_URL: KEYLESS_BASE_URL,
		// OPENAI_API_KEY and HF_TOKEN are deliberately absent — the point of the test.
	},
}));

describe("buildModels against a public, keyless GET /v1/models", () => {
	it("boots the catalogue with no Authorization header when no key is configured", async () => {
		let sawAuthHeader: string | null | undefined;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === `${KEYLESS_BASE_URL}/models`) {
				const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
				sawAuthHeader = headers.get("authorization");
				return new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "public/anon-model",
								description: "served to a caller with no credential at all",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } }
				);
			}
			return realFetch(input, init);
		}) as typeof fetch;

		try {
			const { models } = await import("./models");
			expect(sawAuthHeader).toBeNull();
			expect(models.map((m) => m.id)).toContain("public/anon-model");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
