/**
 * Readiness follows the embedding model alone. The stored `enabled` field was
 * never set by the Knowledge screen, so a deployment with a model chosen used
 * to report "No embedding model is configured" and index nothing.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { statusObject } from "./service";

const caller = {
	userId: new ObjectId(),
	email: null,
	groups: [],
	isAdmin: false,
};

describe("knowledge readiness", () => {
	beforeAll(async () => {
		await ready;
	});

	afterEach(async () => {
		await collections.knowledgeConfig.deleteMany({});
	});

	it("is ready once a model is chosen, with no `enabled` field stored", async () => {
		await collections.knowledgeConfig.insertOne({
			embeddingModel: "embed-model",
			chunkChars: 1200,
			chunkOverlap: 150,
		} as never);

		const status = await statusObject(caller, undefined);

		expect(status).toMatchObject({ ready: true, embedding_model: "embed-model", detail: null });
	});

	it("says no model is chosen when none is", async () => {
		const status = await statusObject(caller, undefined);

		expect(status.ready).toBe(false);
		expect(status.detail).toContain("No embedding model has been chosen");
	});
});
