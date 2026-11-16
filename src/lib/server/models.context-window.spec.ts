/**
 * The window a model reports sizes the large-content threshold. Pystino sends it
 * as a top-level `context_window`; the HF router sends per-provider `context_length`.
 * Isolated for the same reason as models.display-name.spec.ts.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const BASE_URL = "http://context-window-models.test.invalid/v1";

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
						// What the gateway sends for a model and for an alias: a top-level window.
						{ id: "acme/chat", kind: "chat", context_window: 1_048_576, providers: null },
						{ id: "acme/null", kind: "chat", context_window: null },
						// The HF router shape: per provider, smallest positive value wins.
						{
							id: "acme/routed",
							kind: "chat",
							providers: [
								{ context_length: null },
								{ context_length: 0 },
								{ context_length: 262_144 },
								{ context_length: 131_072 },
							],
						},
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

describe("a model's context window from the gateway listing", () => {
	it("reads the gateway's top-level context_window, as an alias carries it", () => {
		expect(built.find((m) => m.id === "acme/chat")?.contextLength).toBe(1_048_576);
	});

	it("is unknown when nothing is reported", () => {
		expect(built.find((m) => m.id === "acme/null")?.contextLength).toBeUndefined();
	});

	it("takes the smallest positive provider value, ignoring null and 0", () => {
		expect(built.find((m) => m.id === "acme/routed")?.contextLength).toBe(131_072);
	});
});
