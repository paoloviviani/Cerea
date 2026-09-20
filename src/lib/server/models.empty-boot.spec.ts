/**
 * The empty-catalogue boot: a fresh install's gateway answers zero chat models
 * (providers are added through the console after install), and the chat must
 * still come up — a crash loop here would take the sign-in page down with it,
 * and the console is the way out of the state. This pins that contract:
 * `publishModels` publishes an empty list at module load without throwing,
 * `defaultModel`/`taskModel` stay undefined, and the TTL refresh heals the
 * catalogue the moment the gateway answers a model.
 *
 * Same isolation pattern as `models.keyless-boot.spec.ts`: `models.ts` runs
 * `buildModels()` at module scope, so this needs its own `$env/dynamic/*`
 * mocks ahead of that top-level await.
 */
import { describe, expect, it, vi } from "vitest";

const EMPTY_BASE_URL = "http://empty-models.test.invalid/v1";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_ORIGIN: "https://vitest.invalid" } }));
vi.mock("$env/dynamic/private", () => ({
	env: {
		OPENAI_BASE_URL: EMPTY_BASE_URL,
		// No key: the public-catalogue shape the gateway serves (ADR 0081).
	},
}));

describe("boot against a gateway with zero chat models", () => {
	it("publishes an empty catalogue instead of throwing, and heals on refresh", async () => {
		let answered = 0;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			answered += 1;
			if (answered === 1) {
				return new Response(JSON.stringify({ object: "list", data: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({
					object: "list",
					data: [{ id: "late/model", description: "added through the console" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		}) as typeof fetch;

		try {
			const imported = await import("./models");
			// The boot itself: empty is published, nothing threw.
			expect(imported.models).toEqual([]);
			expect(imported.defaultModel).toBeUndefined();
			expect(imported.taskModel).toBeUndefined();
			// While empty, the id schema accepts any string (there are no ids
			// to validate against); it tightens on the first real publish.
			expect(imported.validModelIdSchema.safeParse("anything").success).toBe(true);

			// The refresh path: once the gateway answers a model, the catalogue
			// heals without a restart. The TTL is 60s (a deliberate design
			// value, not test-controllable), so fake time past it.
			vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
			try {
				const healed = await imported.ensureModelsFresh();
				expect(healed.map((m) => m.id)).toEqual(["late/model"]);
				expect(imported.defaultModel?.id).toBe("late/model");
				expect(imported.validModelIdSchema.safeParse("late/model").success).toBe(true);
				expect(imported.validModelIdSchema.safeParse("anything").success).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
