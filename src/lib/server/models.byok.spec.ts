/**
 * Gateway BYOK: a user's own-key model arrives as `my/<name>` with `byok: true`; deployment
 * models carry `byok` null or not at all. Own file for the same reason as
 * `models.display-name.spec.ts` (`buildModels()` runs at module scope).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const BASE_URL = "http://byok-models.test.invalid/v1";

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
						{ id: "my/home-llama", byok: true, kind: "chat" },
						{ id: "acme/null-byok", byok: null, kind: "chat" },
						{ id: "acme/plain", byok: false, kind: "chat" },
						{ id: "acme/absent", kind: "chat" },
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

describe("buildModels with BYOK models", () => {
	it("carries byok on a my/ model and keeps the id intact", () => {
		const model = built.find((m) => m.id === "my/home-llama");
		expect(model?.byok).toBe(true);
		expect(model?.name).toBe("my/home-llama");
	});

	it("reads null, false and absent as not BYOK", () => {
		for (const id of ["acme/null-byok", "acme/plain", "acme/absent"]) {
			expect(built.find((m) => m.id === id)?.byok).toBeFalsy();
		}
	});

	it("serializes byok to the client list as a plain boolean", async () => {
		const { serializeModelSummary } = await import("./api/utils/serializeModel");
		const mine = built.find((m) => m.id === "my/home-llama");
		const other = built.find((m) => m.id === "acme/absent");
		expect(serializeModelSummary(mine as never)).toMatchObject({ id: "my/home-llama", byok: true });
		expect(serializeModelSummary(other as never).byok).toBe(false);
	});
});
