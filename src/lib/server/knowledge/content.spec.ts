import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { KnowledgeError, readDocumentText, type Caller } from "./service";

await ready;

const owner: Caller = {
	userId: new ObjectId(),
	email: "owner@example.org",
	groups: [],
	isAdmin: false,
};
const viewer: Caller = {
	userId: new ObjectId(),
	email: "viewer@example.org",
	groups: [],
	isAdmin: false,
};
const stranger: Caller = {
	userId: new ObjectId(),
	email: "stranger@example.org",
	groups: [],
	isAdmin: false,
};

let storeId: ObjectId;

beforeEach(async () => {
	const base = {
		_id: new ObjectId(),
		name: "reports",
		description: "",
		ownerId: owner.userId,
		embeddingModel: "test-embedder",
		dimensions: null,
		chunkChars: 1200,
		chunkOverlap: 150,
		shares: [{ kind: "user" as const, principal: viewer.email ?? "", role: "viewer" as const }],
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	await collections.vectorStores.insertOne(base);
	storeId = base._id;
});

afterEach(async () => {
	await collections.vectorStores.deleteMany({});
	await collections.knowledgeDocuments.deleteMany({});
});

function insertDocument(over: Partial<Record<string, unknown>>) {
	return collections.knowledgeDocuments.insertOne({
		_id: new ObjectId(),
		storeId,
		title: "Q3 numbers",
		status: "ready",
		chars: 5,
		chunkCount: 1,
		error: "",
		embeddingModel: null,
		indexedAt: new Date(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	} as never);
}

describe("readDocumentText", () => {
	it("returns the indexed text to the owner", async () => {
		const doc = await insertDocument({ text: "a,b\n1,2\n", filename: "numbers.csv" });
		const result = await readDocumentText(storeId.toString(), doc.insertedId.toString(), owner);
		expect(result.text).toBe("a,b\n1,2\n");
		expect(result.filename).toBe("numbers.csv");
	});

	it("serves shared viewers but not strangers, like retrieval does", async () => {
		const doc = await insertDocument({ text: "hello" });
		const shared = await readDocumentText(storeId.toString(), doc.insertedId.toString(), viewer);
		expect(shared.text).toBe("hello");
		await expect(
			readDocumentText(storeId.toString(), doc.insertedId.toString(), stranger)
		).rejects.toMatchObject({ status: 404 });
	});

	it("refuses a document whose text has not landed yet", async () => {
		const doc = await insertDocument({ status: "pending", text: undefined });
		await expect(
			readDocumentText(storeId.toString(), doc.insertedId.toString(), owner)
		).rejects.toMatchObject({ status: 409 });
	});

	it("refuses text over the runtime's 50 MB cap by name", async () => {
		// A single BSON document cannot hold 50 MB (Mongo's 16 MB document cap
		// rejects the insert itself), so the oversized answer arrives through a
		// stubbed read: what the cap guards is what readDocumentText returns,
		// not how the row got there.
		const big = "x".repeat(50 * 1024 * 1024 + 1);
		const findOne = vi.spyOn(collections.knowledgeDocuments, "findOne").mockResolvedValue({
			_id: new ObjectId(),
			storeId,
			title: "Q3 numbers",
			status: "ready",
			text: big,
			chars: big.length,
			chunkCount: 1,
			error: "",
			filename: null,
		} as never);
		try {
			await expect(
				readDocumentText(storeId.toString(), new ObjectId().toString(), owner)
			).rejects.toMatchObject({ status: 413 });
		} finally {
			findOne.mockRestore();
		}
	});

	it("404s a document from another store", async () => {
		const doc = await insertDocument({ text: "secret" });
		await collections.vectorStores.insertOne({
			_id: new ObjectId(),
			name: "other",
			description: "",
			ownerId: owner.userId,
			embeddingModel: "test-embedder",
			dimensions: null,
			chunkChars: 1200,
			chunkOverlap: 150,
			shares: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const otherStoreId = (
			await collections.vectorStores.findOne({ name: "other" })
		)?._id.toString();
		await expect(
			readDocumentText(otherStoreId ?? "", doc.insertedId.toString(), owner)
		).rejects.toMatchObject({ status: 404 });
	});

	it("keeps KnowledgeError shape for the forwarder's pass-through", () => {
		const err = new KnowledgeError(404, "No such document.");
		expect(err.status).toBe(404);
	});
});
