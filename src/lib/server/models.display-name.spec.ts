/**
 * The gateway's `display_name` is what a model picker shows, and `id` is what a
 * request carries — two different questions that one field cannot answer. The
 * catalogue answered the second and dropped the first: the gateway mapping set
 * `displayName: m.id` unconditionally, so an operator who named a model in the
 * console saw the raw id everywhere in the chat (and a rename, when it comes,
 * would have had nothing to show).
 *
 * Isolated in its own file because `models.ts` runs `buildModels()` at module
 * scope: this needs its own `$env/dynamic/*` mocks ahead of that top-level
 * await, the same reason `models.keyless-boot.spec.ts` stands alone. One stub,
 * one import, both models in one listing — the catalogue is built once per
 * module, so a second fixture could never reach it.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const BASE_URL = "http://display-name-models.test.invalid/v1";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_ORIGIN: "https://vitest.invalid" } }));
vi.mock("$env/dynamic/private", () => ({
	env: {
		// Without a MONGODB_URL the database module starts mongodb-memory-server, which needs AVX.
		MONGODB_URL: process.env.TEST_MONGODB_URL,
		OPENAI_BASE_URL: BASE_URL,
		OPENAI_API_KEY: "not-used",
	},
}));

let built: Awaited<typeof import("./models")>["models"];

beforeAll(async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === `${BASE_URL}/models`) {
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{ id: "acme/fast-1", display_name: "Fast summariser", kind: "chat" },
						{ id: "acme/unnamed", kind: "chat" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		}
		return realFetch(input, init);
	}) as typeof fetch;
	try {
		built = (await import("./models")).models;
	} finally {
		globalThis.fetch = realFetch;
	}
});

describe("buildModels against a gateway that names its models", () => {
	it("uses the display name a picker shows, and keeps the id as the id", () => {
		const model = built.find((m) => m.id === "acme/fast-1");
		expect(model?.displayName).toBe("Fast summariser");
		// The id is the identity: what a conversation stores and a request
		// sends, so the label must not have replaced it.
		expect(model?.name).toBe("acme/fast-1");
	});

	it("falls back to the id when the gateway names nothing", () => {
		const model = built.find((m) => m.id === "acme/unnamed");
		expect(model?.displayName).toBe("acme/unnamed");
	});
});
