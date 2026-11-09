/**
 * The index of a project's past chats, as the project settings page shows it
 * and lets its owner repair it.
 *
 * Status is open to everyone who can see the project (counts and one plain
 * sentence, never a transcript). Reindex and Retry are the owner's, through
 * the same service calls a knowledge base's owner uses (`reindex`,
 * `retryDocument`), so the ownership rule is that of `reindexTarget`: a legacy
 * base some other member owns is refused there, not here.
 */

import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { indexErrorForUser } from "./indexError";
import type { PastChatsIndex } from "$lib/types/Project";

export async function pastChatsIndex(
	memoryBaseId: string | undefined,
	token?: string
): Promise<PastChatsIndex> {
	const { embeddingModelsFor, readConfig } = await import("./service");
	const [models, config] = await Promise.all([embeddingModelsFor(token), readConfig()]);
	const choice = { models: models ?? [], defaultModel: config.embeddingModel ?? null };
	if (!memoryBaseId || !ObjectId.isValid(memoryBaseId)) {
		return {
			state: "none",
			indexed: 0,
			indexing: 0,
			failed: 0,
			error: null,
			embeddingModel: null,
			embeddingChosen: false,
			...choice,
		};
	}
	const storeId = new ObjectId(memoryBaseId);
	const base = await collections.vectorStores.findOne(
		{ _id: storeId },
		{ projection: { embeddingModel: 1, embeddingChosen: 1 } }
	);
	const rows = await collections.knowledgeDocuments
		.find({ storeId }, { projection: { status: 1, error: 1 } })
		.toArray();
	let indexed = 0;
	let indexing = 0;
	let failed = 0;
	let error: string | null = null;
	for (const row of rows) {
		if (row.status === "ready") indexed++;
		else if (row.status === "failed") {
			failed++;
			error ??= indexErrorForUser(row.error) ?? null;
		} else indexing++;
	}
	const state =
		failed > 0 ? "failed" : indexing > 0 ? "indexing" : indexed > 0 ? "indexed" : "none";
	return {
		state,
		indexed,
		indexing,
		failed,
		error,
		embeddingModel: base?.embeddingModel || null,
		embeddingChosen: base?.embeddingChosen === true,
		...choice,
	};
}

/** The ids of the failed documents in a base, for Retry. */
export async function failedDocumentIds(memoryBaseId: string): Promise<string[]> {
	const rows = await collections.knowledgeDocuments
		.find({ storeId: new ObjectId(memoryBaseId), status: "failed" }, { projection: { _id: 1 } })
		.toArray();
	return rows.map((row) => row._id.toString());
}
