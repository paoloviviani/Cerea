/**
 * Pystino mode never sends a shared key (#16): even with a key in the
 * environment the boot catalogue is fetched without an Authorization header.
 * The chat then refuses that mix at startup (modelMode.spec.ts); this pins the
 * catalogue path on its own, so no code path can quietly use the key.
 *
 * Own file for the reason models.keyless-boot.spec.ts gives: models.ts builds
 * the catalogue at module scope.
 */
import { describe, expect, it, vi } from "vitest";

const BASE_URL = "http://pystino-no-key.test.invalid/v1";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_ORIGIN: "https://vitest.invalid" } }));
vi.mock("$env/dynamic/private", () => ({
	env: {
		MONGODB_URL: process.env.TEST_MONGODB_URL,
		OPENAI_BASE_URL: BASE_URL,
		USE_USER_TOKEN: "true",
		OPENAI_API_KEY: "sk-must-not-leave",
	},
}));
vi.mock("$lib/server/modelMode", async (importOriginal) => {
	const real = await importOriginal<typeof import("./modelMode")>();
	// Skip the boot refusal to prove the catalogue path itself is key-free.
	return { ...real, assertModelModeValid: () => "pystino" as const };
});

describe("Pystino mode boot catalogue", () => {
	it("sends no Authorization header", async () => {
		let sawAuthHeader: string | null | undefined;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === `${BASE_URL}/models`) {
				const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
				sawAuthHeader = headers.get("authorization");
				return new Response(JSON.stringify({ object: "list", data: [{ id: "m/one" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return realFetch(input, init);
		}) as typeof fetch;
		try {
			const { models } = await import("./models");
			expect(sawAuthHeader).toBeNull();
			expect(models.map((m) => m.id)).toContain("m/one");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
