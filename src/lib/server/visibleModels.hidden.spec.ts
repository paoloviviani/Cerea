/**
 * An administrator-hidden model (HIDDEN_MODELS) is unlisted for users: not in
 * any model list, not newly selectable, not resolvable through the public
 * model API; yet it stays in the registry (titles use it) and the default
 * model is never hidden.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_ORIGIN: "https://vitest.invalid" } }));
vi.mock("$env/dynamic/private", () => ({
	env: {
		MONGODB_URL: process.env.TEST_MONGODB_URL,
		OPENAI_BASE_URL: "http://hidden-models.test.invalid/v1",
		OPENAI_API_KEY: "sk-deployment-key",
		HIDDEN_MODELS: "org/beta, org/alpha",
	},
}));
vi.mock("$lib/server/database", () => ({
	collections: { settings: { findOne: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("$lib/server/auth", () => ({ authCondition: vi.fn(() => ({})) }));

const SHARED = [{ id: "org/alpha" }, { id: "org/beta" }, { id: "org/gamma" }];
const anon = { token: undefined, sessionId: "s", isAdmin: false } as never;

describe("admin-hidden models", () => {
	const realFetch = globalThis.fetch;
	beforeEach(() => {
		globalThis.fetch = (async () =>
			Response.json({ object: "list", data: SHARED })) as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("leaves the hidden model out of the user list but keeps the default", async () => {
		const { visibleModels } = await import("./visibleModels");
		expect((await visibleModels(anon)).map((m) => m.id)).toEqual(["org/alpha", "org/gamma"]);
	});

	it("refuses to newly select it, and still resolves it in the registry", async () => {
		const { isSelectableCatalogueId } = await import("./visibleModels");
		const { models } = await import("./models");
		const known = (id: string) => models.some((m) => m.id === id);
		expect(await isSelectableCatalogueId(anon, "org/beta", known)).toBe(false);
		expect(await isSelectableCatalogueId(anon, "org/gamma", known)).toBe(true);
		expect(models.some((m) => m.id === "org/beta")).toBe(true);
	});

	it("is a 404 on the public model API, which is for users", async () => {
		const { resolveModel } = await import("./api/utils/resolveModel");
		await expect(resolveModel("org", "beta")).rejects.toMatchObject({ status: 404 });
		await expect(resolveModel("org", "gamma")).resolves.toMatchObject({ id: "org/gamma" });
	});

	it("lets an existing conversation on it keep its model (the registry resolves it)", async () => {
		const { resolveConversationModel } = await import("./customModels");
		const { models } = await import("./models");
		const found = await resolveConversationModel("org/beta", { userId: "u" }, models);
		expect(found?.model.id).toBe("org/beta");
	});
});
