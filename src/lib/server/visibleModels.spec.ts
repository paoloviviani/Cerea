/**
 * The per-caller models listing carries the billing group (ADR 0061).
 *
 * A Cerea request is billed to the person's chosen billing group, and the
 * gateway lists exactly what a request billed to that group accepts. Before
 * this, `visibleModels`'s per-caller fetch went out with only the person's
 * OIDC token, so the gateway listed against the person's *default* — anyone
 * with more than one group could see a model the send path then refused
 * (the owner's report). `x-bill-to` rides along now, from the billing
 * organisation stored in the person's settings, and `visibleModels` is the
 * one place that reads it — every caller (the models route, the custom-model
 * base check) gets the same answer.
 *
 * Uses `vi.mock("$lib/server/database")` and `vi.mock("$lib/server/auth")`
 * rather than the real modules: the real database module starts an
 * in-memory Mongo (AVX-ridden) and the real auth module pulls the OIDC
 * setup, and what this test needs of either is one small function each.
 * The catalogue at $env/dynamic/private is mocked ahead of the top-level
 * `buildModels()` await, same isolation pattern as
 * `models.empty-boot.spec.ts`.
 *
 * The two fetches to the gateway are told apart by their Authorization
 * headers: the catalogue is boot-fetched with the deployment key
 * (OPENAI_API_KEY), the per-caller fetch with the person's OIDC token.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const GATEWAY_BASE = "http://models.test.invalid/v1";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_ORIGIN: "https://vitest.invalid" } }));
vi.mock("$env/dynamic/private", () => ({
	env: {
		// Nothing hosts Mongo here: without a real MONGODB_URL the database
		// module starts mongodb-memory-server, but that module is mocked
		// below anyway.
		MONGODB_URL: process.env.TEST_MONGODB_URL,
		OPENAI_BASE_URL: GATEWAY_BASE,
		OPENAI_API_KEY: "sk-deployment-key",
	},
}));
vi.mock("$lib/server/database", () => ({
	collections: {
		settings: {
			findOne: vi.fn(),
		},
	},
}));
vi.mock("$lib/server/auth", () => ({
	authCondition: vi.fn((locals: Pick<App.Locals, "user" | "sessionId">) =>
		locals.user ? { userId: locals.user._id } : { sessionId: locals.sessionId }
	),
}));

type Recorded = { url: string; init: RequestInit };

describe("visibleModels installs the billing group on the per-caller fetch", () => {
	const realFetch = globalThis.fetch;
	let requests: Recorded[];

	beforeEach(() => {
		requests = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const record: Recorded = { url, init: init ?? {} };
			requests.push(record);
			// The catalogue: two models the fresh deployment serves. The stub
			// filters nothing, whatever was sent — so every test below is
			// also asserting against the "older gateway that ignores the
			// header" shape.
			return new Response(
				JSON.stringify({
					object: "list",
					data: [{ id: "org/alpha" }, { id: "org/beta" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	async function importVisibleModels() {
		// The catalogue modules import at first use; the fetch stub is in
		// place by now (beforeEach ran).
		return await import("./visibleModels");
	}

	it("sends x-bill-to with the person's own token, from their stored billing group", async () => {
		const { visibleModels } = await importVisibleModels();
		const { collections } = await import("$lib/server/database");
		vi.mocked(collections.settings.findOne).mockResolvedValue({ billingOrganization: "beta" });

		const models = await visibleModels({
			token: "person-oidc-token",
			sessionId: "session-1",
			isAdmin: false,
		});

		expect(models.map((m) => m.id)).toEqual(["org/alpha", "org/beta"]);
		const perCaller = requests.filter(
			(r) =>
				(r.init.headers as Record<string, string>)?.Authorization === "Bearer person-oidc-token"
		);
		expect(perCaller).toHaveLength(1);
		expect(perCaller[0].init.headers).toMatchObject({ "x-bill-to": "beta" });
	});

	it("adds no header when no billing organisation is chosen", async () => {
		const { visibleModels } = await importVisibleModels();
		const { collections } = await import("$lib/server/database");
		vi.mocked(collections.settings.findOne).mockResolvedValue(null);

		await visibleModels({
			token: "person-oidc-token",
			sessionId: "session-1",
			isAdmin: false,
		});

		const perCaller = requests.filter(
			(r) =>
				(r.init.headers as Record<string, string>)?.Authorization === "Bearer person-oidc-token"
		);
		expect(perCaller).toHaveLength(1);
		expect(perCaller[0].init.headers).not.toHaveProperty("x-bill-to");
	});

	it("never sends a header on a key-authenticated fetch: the deployment catalogue fetch carries no x-bill-to", async () => {
		const { visibleModels } = await importVisibleModels();
		const { collections } = await import("$lib/server/database");
		vi.mocked(collections.settings.findOne).mockResolvedValue({ billingOrganization: "beta" });

		// No token: there is nobody to filter for. The only fetch is the
		// catalogue's own, made with the deployment key — and it must not
		// carry a billing header, since the gateway refuses x-bill-to from
		// a key. The TTL is 60 s and earlier tests in this file already
		// filled it, so fake time past it to see this test's own fetch.
		vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
		let models: Awaited<ReturnType<typeof visibleModels>>;
		try {
			models = await visibleModels({
				sessionId: "session-1",
				isAdmin: false,
			});
		} finally {
			vi.useRealTimers();
		}

		expect(models.map((m) => m.id)).toEqual(["org/alpha", "org/beta"]);
		const keyFetch = requests.filter(
			(r) =>
				(r.init.headers as Record<string, string>)?.Authorization === "Bearer sk-deployment-key"
		);
		expect(keyFetch).toHaveLength(1);
		expect(keyFetch[0].init.headers).not.toHaveProperty("x-bill-to");
		// And nothing else was asked with any credential for this call.
		expect(requests).toHaveLength(1);
	});

	it("against an older gateway that ignores the header, the unfiltered answer renders whole", async () => {
		const { visibleModels } = await importVisibleModels();
		const { collections } = await import("$lib/server/database");
		vi.mocked(collections.settings.findOne).mockResolvedValue({ billingOrganization: "beta" });

		// The per-caller fetch above already answers with the whole
		// catalogue regardless of what was sent (the stub filters nothing):
		// this is that case verbatim — a request billed to beta against a
		// gateway that does not narrow — and it renders both models rather
		// than failing or blanking.
		const models = await visibleModels({
			token: "person-oidc-token",
			sessionId: "session-1",
			isAdmin: false,
		});
		expect(models.map((m) => m.id)).toEqual(["org/alpha", "org/beta"]);
	});
});
