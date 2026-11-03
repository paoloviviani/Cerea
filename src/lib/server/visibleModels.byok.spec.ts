/**
 * A user's own-key models (`my/<name>`, gateway BYOK) come from THEIR per-caller
 * `/v1/models` and only there: they reach the owner's list and send validation,
 * never another user's, and never the shared catalogue.
 *
 * Same isolation as `visibleModels.spec.ts`. The deployment key fetches the
 * shared catalogue (no `my/`); each user's token gets their own list.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const GATEWAY_BASE = "http://byok-visible.test.invalid/v1";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_ORIGIN: "https://vitest.invalid" } }));
vi.mock("$env/dynamic/private", () => ({
	env: {
		MONGODB_URL: process.env.TEST_MONGODB_URL,
		OPENAI_BASE_URL: GATEWAY_BASE,
		OPENAI_API_KEY: "sk-deployment-key",
	},
}));
vi.mock("$lib/server/database", () => ({
	collections: { settings: { findOne: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("$lib/server/auth", () => ({
	authCondition: vi.fn((locals: Pick<App.Locals, "user" | "sessionId">) =>
		locals.user ? { userId: locals.user._id } : { sessionId: locals.sessionId }
	),
}));

const SHARED = [{ id: "org/alpha" }, { id: "org/beta" }];
const OWN_A = { id: "my/a-llama", byok: true, kind: "chat", display_name: "A's Llama" };

const asA = { token: "token-a", sessionId: "s-a", isAdmin: false };
const asB = { token: "token-b", sessionId: "s-b", isAdmin: false };

describe("BYOK models for the caller", () => {
	const realFetch = globalThis.fetch;
	let gatewayDown = false;

	beforeEach(() => {
		gatewayDown = false;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
			if (auth === "Bearer token-a" || auth === "Bearer token-b") {
				if (gatewayDown) return new Response("nope", { status: 503 });
				const own = auth === "Bearer token-a" ? [OWN_A] : [];
				return Response.json({ object: "list", data: [...SHARED, ...own] });
			}
			return Response.json({ object: "list", data: SHARED });
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("lists the owner's my/ model, processed like a catalogue model", async () => {
		const { visibleModels } = await import("./visibleModels");
		const list = await visibleModels(asA);
		expect(list.map((m) => m.id)).toEqual(["org/alpha", "org/beta", "my/a-llama"]);
		const own = list.find((m) => m.id === "my/a-llama");
		expect(own).toMatchObject({ byok: true, displayName: "A's Llama", unlisted: false });
		expect(typeof own?.getEndpoint).toBe("function");
	});

	it("does not give it to another user", async () => {
		const { visibleModels } = await import("./visibleModels");
		expect((await visibleModels(asB)).map((m) => m.id)).toEqual(["org/alpha", "org/beta"]);
	});

	it("never adds it to the shared catalogue", async () => {
		const { visibleModels } = await import("./visibleModels");
		const { models, ensureModelsFresh } = await import("./models");
		await visibleModels(asA);
		expect((await ensureModelsFresh()).some((m) => m.id.startsWith("my/"))).toBe(false);
		expect(models.some((m) => m.id.startsWith("my/"))).toBe(false);
	});

	it("falls back to the shared list when the gateway cannot be asked", async () => {
		const { visibleModels } = await import("./visibleModels");
		gatewayDown = true;
		expect((await visibleModels(asA)).map((m) => m.id)).toEqual(["org/alpha", "org/beta"]);
	});

	it("accepts a my/ id for its owner and refuses it for anyone else", async () => {
		const { isSelectableCatalogueId } = await import("./visibleModels");
		const shared = (id: string) => SHARED.some((m) => m.id === id);
		expect(await isSelectableCatalogueId(asA, "my/a-llama", shared)).toBe(true);
		expect(await isSelectableCatalogueId(asB, "my/a-llama", shared)).toBe(false);
		expect(await isSelectableCatalogueId(asA, "my/other", shared)).toBe(false);
		expect(await isSelectableCatalogueId(asB, "org/alpha", shared)).toBe(true);
		gatewayDown = true;
		expect(await isSelectableCatalogueId(asA, "my/a-llama", shared)).toBe(false);
	});

	it("resolves a my/ conversation to the owner's model only", async () => {
		const { modelsFor } = await import("./visibleModels");
		const { resolveConversationModel } = await import("./customModels");
		const owner = { userId: "u" };
		const forA = await resolveConversationModel(
			"my/a-llama",
			owner,
			await modelsFor(asA, "my/a-llama")
		);
		expect(forA?.model.id).toBe("my/a-llama");
		const forB = await resolveConversationModel(
			"my/a-llama",
			owner,
			await modelsFor(asB, "my/a-llama")
		);
		expect(forB).toBeUndefined();
	});

	it("does not ask the gateway for a catalogue id", async () => {
		const { modelsFor } = await import("./visibleModels");
		const { models } = await import("./models");
		const spy = vi.spyOn(globalThis, "fetch");
		expect(await modelsFor(asA, "org/alpha")).toBe(models);
		expect(spy).not.toHaveBeenCalled();
	});
});
