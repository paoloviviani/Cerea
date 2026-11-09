/**
 * A user's choice of embedding model for a base: who may make it, that it must
 * be a model they can use, that it reindexes with the new model, and that a
 * query embeds with the base's own model, never the deployment's default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const { getMock, embedMock } = vi.hoisted(() => ({ getMock: vi.fn(), embedMock: vi.fn() }));

vi.mock("$lib/server/gatewayServer", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/gatewayServer")>()),
	gateway: { get: getMock },
}));
vi.mock("./embed", () => ({ embed: embedMock }));

import { collections, ready } from "$lib/server/database";
import type { VectorStore } from "$lib/types/VectorStore";
import { GatewayCallFailed } from "$lib/server/gatewayServer";
import {
	KnowledgeError,
	createStore,
	reindex,
	search,
	statusObject,
	storeObject,
	type Caller,
} from "./service";

await ready;

const owner: Caller = {
	userId: new ObjectId(),
	email: "o@example.org",
	groups: [],
	isAdmin: false,
};
const editor: Caller = {
	userId: new ObjectId(),
	email: "e@example.org",
	groups: [],
	isAdmin: false,
};
const reader: Caller = {
	userId: new ObjectId(),
	email: "r@example.org",
	groups: [],
	isAdmin: false,
};

const catalogue = (...ids: string[]) => ({
	data: ids.map((id) => ({ id, kind: "embedding" })),
});

async function status(p: Promise<unknown>): Promise<number | "ok"> {
	try {
		await p;
		return "ok";
	} catch (err) {
		if (err instanceof KnowledgeError) return err.status;
		throw err;
	}
}

beforeEach(async () => {
	getMock.mockReset();
	embedMock.mockReset();
	getMock.mockResolvedValue(catalogue("default-embed", "other-embed"));
	await collections.knowledgeConfig.deleteMany({});
	await collections.knowledgeConfig.insertOne({
		enabled: true,
		embeddingModel: "default-embed",
		passagePrefix: "passage: ",
		queryPrefix: "query: ",
		chunkChars: 1200,
		chunkOverlap: 150,
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
});

afterEach(async () => {
	await collections.vectorStores.deleteMany({});
	await collections.knowledgeConfig.deleteMany({});
});

const row = async (id: string): Promise<VectorStore> =>
	(await collections.vectorStores.findOne({ _id: new ObjectId(id) })) as VectorStore;

describe("choosing the embedding model", () => {
	it("creates a base on the default, or on a model the user may use", async () => {
		const def = await createStore(owner, { name: "a" }, "tok");
		expect(await row(def.id)).toMatchObject({
			embeddingModel: "default-embed",
			passagePrefix: "passage: ",
		});
		expect((await row(def.id)).embeddingChosen).toBeFalsy();

		const chosen = await createStore(owner, { name: "b", embedding_model: "other-embed" }, "tok");
		expect(await row(chosen.id)).toMatchObject({
			embeddingModel: "other-embed",
			embeddingChosen: true,
			// The default model's prefixes do not belong to another model.
			passagePrefix: "",
		});
		expect(chosen).toMatchObject({ embedding_model: "other-embed", embedding_chosen: true });
	});

	it("refuses a model outside the user's catalogue with a 400", async () => {
		expect(
			await status(createStore(owner, { name: "c", embedding_model: "secret-embed" }, "tok"))
		).toBe(400);
		// And when the catalogue cannot be read at all.
		getMock.mockRejectedValue(new Error("down"));
		expect(
			await status(createStore(owner, { name: "d", embedding_model: "other-embed" }, "tok"))
		).toBe(400);
	});

	it("reindexes with the new model, resets the width, and only for the owner", async () => {
		const made = await createStore(owner, { name: "e" }, "tok");
		await collections.vectorStores.updateOne(
			{ _id: new ObjectId(made.id) },
			{
				$set: {
					dimensions: 768,
					shares: [{ kind: "user", principal: editor.email ?? "", role: "editor" }],
				},
			}
		);

		expect(await status(reindex(made.id, editor, "tok", { embeddingModel: "other-embed" }))).toBe(
			403
		);
		expect(await status(reindex(made.id, reader, "tok", { embeddingModel: "other-embed" }))).toBe(
			404
		);
		expect((await row(made.id)).embeddingModel).toBe("default-embed");

		expect(await status(reindex(made.id, owner, "tok", { embeddingModel: "nope" }))).toBe(400);
		expect((await row(made.id)).embeddingModel).toBe("default-embed");

		await reindex(made.id, owner, "tok", { embeddingModel: "other-embed" });
		expect(await row(made.id)).toMatchObject({
			embeddingModel: "other-embed",
			embeddingChosen: true,
			dimensions: null,
		});

		// A plain reindex keeps the owner's choice; "" returns to the default.
		await reindex(made.id, owner, "tok");
		expect((await row(made.id)).embeddingModel).toBe("other-embed");
		await reindex(made.id, owner, "tok", { embeddingModel: "" });
		expect(await row(made.id)).toMatchObject({
			embeddingModel: "default-embed",
			embeddingChosen: false,
			passagePrefix: "passage: ",
		});
	});

	it("refuses a plain reindex of a chosen base whose model the caller can no longer use", async () => {
		const made = await createStore(owner, { name: "r", embedding_model: "other-embed" }, "tok");
		getMock.mockResolvedValue(catalogue("default-embed"));
		expect(await status(reindex(made.id, owner, "tok"))).toBe(400);
		expect((await row(made.id)).reindexingSince ?? null).toBeNull();
		// An administrator reindexing with their own token is refused the same way.
		const admin: Caller = { ...reader, isAdmin: true };
		expect(await status(reindex(made.id, admin, "admin-tok", { asAdmin: true }))).toBe(400);
		expect((await row(made.id)).embeddingModel).toBe("other-embed");
	});

	it("refuses a second reindex while one holds the claim, and takes over a stale claim", async () => {
		const made = await createStore(owner, { name: "c" }, "tok");
		const id = new ObjectId(made.id);
		await collections.vectorStores.updateOne(
			{ _id: id },
			{ $set: { reindexingSince: new Date() } }
		);
		expect(await status(reindex(made.id, owner, "tok"))).toBe(409);
		await collections.vectorStores.updateOne(
			{ _id: id },
			{ $set: { reindexingSince: new Date(Date.now() - 60 * 60 * 1000) } }
		);
		expect(await status(reindex(made.id, owner, "tok"))).toBe("ok");
		expect((await row(made.id)).embeddingGeneration).toBe(1);
		expect((await row(made.id)).reindexingSince ?? null).toBeNull();
	});

	it("gives a chosen model its own known prefixes", async () => {
		getMock.mockResolvedValue(catalogue("default-embed", "multilingual-e5-large"));
		const made = await createStore(
			owner,
			{ name: "p", embedding_model: "multilingual-e5-large" },
			"tok"
		);
		expect(await row(made.id)).toMatchObject({
			passagePrefix: "passage: ",
			queryPrefix: "query: ",
		});
	});

	it("is never stale for a chosen model, and offers the user's models in the status", async () => {
		const made = await createStore(owner, { name: "f", embedding_model: "other-embed" }, "tok");
		await collections.vectorStores.updateOne(
			{ _id: new ObjectId(made.id) },
			{ $set: { dimensions: 384 } }
		);
		expect((await storeObject(await row(made.id), owner)).stale).toBe(false);
		const state = await statusObject(owner, "tok");
		expect(state).toMatchObject({
			ready: true,
			embedding_model: "default-embed",
			embedding_models: ["default-embed", "other-embed"],
		});
	});

	it("is ready with no default when the user has a model to choose", async () => {
		await collections.knowledgeConfig.deleteMany({});
		expect((await statusObject(owner, "tok")).ready).toBe(true);
		getMock.mockResolvedValue(catalogue());
		expect((await statusObject(owner, "tok")).detail).toContain("No embedding model");
	});
});

describe("searching a base", () => {
	async function indexedBase(model: string) {
		const made = await createStore(owner, { name: "g", embedding_model: model }, "tok");
		await collections.vectorStores.updateOne(
			{ _id: new ObjectId(made.id) },
			{
				$set: {
					dimensions: 384,
					shares: [{ kind: "user", principal: reader.email ?? "", role: "viewer" }],
				},
			}
		);
		return made.id;
	}

	it("embeds the query with the base's own model, never the deployment default", async () => {
		const id = await indexedBase("other-embed");
		embedMock.mockResolvedValue([[0.1, 0.2]]);
		await status(search(id, owner, "tok", { query: "q" }));
		expect(embedMock).toHaveBeenCalled();
		expect(embedMock.mock.calls.every((call) => call[1] === "other-embed")).toBe(true);
		// A chosen model's query prefix is its own (none), not the default's.
		expect(embedMock.mock.calls[0]?.[4]).toBe("");
	});

	it("says a shared base's model is not available to the reader, not the gateway's refusal", async () => {
		const id = await indexedBase("other-embed");
		embedMock.mockRejectedValue(new GatewayCallFailed(403, "model not permitted for this key"));
		getMock.mockResolvedValue(catalogue("default-embed"));
		const err = await search(id, reader, "reader-tok", { query: "q" }).catch((e) => e);
		expect(err).toBeInstanceOf(KnowledgeError);
		expect(err.message).toBe("This knowledge base uses other-embed, which isn't available to you.");
	});
});
