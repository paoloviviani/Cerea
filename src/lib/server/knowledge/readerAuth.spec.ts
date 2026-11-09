/**
 * Who may change a base's reader and re-read a document, and what a bad
 * reader does, against the real Mongo only (no Postgres, so CI runs it). The
 * ingest queue and the reader catalogue are stood in for: what is under test
 * is everything up to the point the work is queued.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("./readers", () => ({
	readerModelsFor: async () => [
		{ id: "markitdown", local: true },
		{ id: "docling", local: true },
		{ id: "mistral-ocr", local: false },
	],
}));
vi.mock("$lib/server/files/extractDocument", () => ({
	documentMime: (mime: string) => mime,
	isExtractableDocument: (mime: string) => mime === "application/pdf",
}));
vi.mock("$lib/server/admin", () => ({
	callerIdentity: async () => ({ email: null, groups: [], isAdmin: false }),
}));

import { collections, ready } from "$lib/server/database";
import { removeBlobs } from "$lib/server/blobs/testing";

let svc: typeof import("./service");
let queued: unknown[][] = [];

const caller = (userId: ObjectId, email: string | null = null) => ({
	userId,
	email,
	groups: [],
	isAdmin: false,
});

const owner = new ObjectId();
const ownerCaller = caller(owner, "owner@example.org");
const editor = caller(new ObjectId(), "ed@example.org");
const viewer = caller(new ObjectId(), "view@example.org");
const stranger = caller(new ObjectId(), "nobody@example.org");

async function seed(documentStatus = "ready") {
	const now = new Date();
	const storeId = new ObjectId();
	await collections.vectorStores.insertOne({
		_id: storeId,
		name: "kb",
		ownerId: owner,
		embeddingModel: "embed",
		dimensions: null,
		chunkChars: 1200,
		chunkOverlap: 150,
		shares: [
			{ kind: "user", principal: "ed@example.org", role: "editor" },
			{ kind: "user", principal: "view@example.org", role: "viewer" },
		],
		createdAt: now,
		updatedAt: now,
	} as never);
	const fileId = new ObjectId();
	await collections.blobStore.put(
		"files",
		{
			id: fileId,
			filename: "a.pdf",
			metadata: { mime: "application/pdf", owner: owner.toString() },
		},
		Buffer.from("%PDF-1.4 fake")
	);
	const document = {
		_id: new ObjectId(),
		storeId,
		fileId,
		filename: "a.pdf",
		title: "a.pdf",
		text: "old text",
		chars: 8,
		chunkCount: 1,
		status: documentStatus,
		error: "",
		embeddingModel: "embed",
		indexedAt: now,
		createdAt: now,
		updatedAt: now,
	};
	await collections.knowledgeDocuments.insertOne(document as never);
	const textOnly = { ...document, _id: new ObjectId(), fileId: undefined, title: "note" };
	delete (textOnly as { fileId?: unknown }).fileId;
	await collections.knowledgeDocuments.insertOne(textOnly as never);
	return { storeId: storeId.toString(), documentId: document._id, textId: textOnly._id };
}

beforeAll(async () => {
	await ready;
	svc = await import("./service");
}, 30000);

beforeEach(async () => {
	queued = [];
	vi.spyOn(svc.ingestQueue, "start").mockImplementation(((...args: unknown[]) => {
		queued.push(args);
	}) as never);
	await collections.vectorStores.deleteMany({});
	await collections.knowledgeDocuments.deleteMany({});
	await collections.knowledgeConfig.deleteMany({});
	await removeBlobs({});
});

afterAll(async () => {
	await collections.vectorStores.deleteMany({});
	await collections.knowledgeDocuments.deleteMany({});
	await removeBlobs({});
});

describe("updateStoreReader", () => {
	it('is allowed to the owner and an editor, and "" returns to the default', async () => {
		const { storeId } = await seed();
		expect((await svc.updateStoreReader(storeId, ownerCaller, "t", "docling")).reader_model).toBe(
			"docling"
		);
		expect(
			(await collections.vectorStores.findOne({ _id: new ObjectId(storeId) }))?.readerLocal
		).toBe(true);
		expect((await svc.updateStoreReader(storeId, editor, "t", "mistral-ocr")).reader_model).toBe(
			"mistral-ocr"
		);
		expect((await svc.updateStoreReader(storeId, editor, "t", "")).reader_model).toBeNull();
		const row = await collections.vectorStores.findOne({ _id: new ObjectId(storeId) });
		expect(row?.readerModel).toBeUndefined();
	});

	// A viewer share does not reach a base for editing at all, so a viewer gets
	// the same 404 as a stranger (`reachableStore`; retry.spec pins it too).
	it("refuses a viewer and a stranger with 404, changing nothing", async () => {
		const { storeId } = await seed();
		await expect(svc.updateStoreReader(storeId, viewer, "t", "docling")).rejects.toMatchObject({
			status: 404,
		});
		await expect(svc.updateStoreReader(storeId, stranger, "t", "docling")).rejects.toMatchObject({
			status: 404,
		});
		expect(
			(await collections.vectorStores.findOne({ _id: new ObjectId(storeId) }))?.readerModel
		).toBeUndefined();
	});

	it("refuses a reader the user may not use, and a non-string, with 400", async () => {
		const { storeId } = await seed();
		for (const bad of ["not-mine", 7, { a: 1 }, ["docling"], true]) {
			await expect(svc.updateStoreReader(storeId, ownerCaller, "t", bad)).rejects.toMatchObject({
				status: 400,
			});
		}
	});

	it("createStore refuses a non-string reader with 400 too", async () => {
		await expect(
			svc.createStore(ownerCaller, { name: "x", reader_model: 5 as never }, "t")
		).rejects.toMatchObject({ status: 400 });
	});
});

describe("rereadDocument, up to the queue", () => {
	it("queues for the owner and an editor, claiming the document", async () => {
		const { storeId, documentId } = await seed();
		const shown = await svc.rereadDocument(storeId, documentId.toString(), editor, "t", "docling");
		expect(shown.status).toBe("pending");
		expect(queued).toHaveLength(1);
		expect(queued[0][3]).toEqual({ reread: true, reader: "docling", readerLocal: true });
		expect((await collections.knowledgeDocuments.findOne({ _id: documentId }))?.status).toBe(
			"pending"
		);
	});

	it('not given passes no reader; "" passes an explicit null', async () => {
		const { storeId, documentId } = await seed();
		await svc.rereadDocument(storeId, documentId.toString(), ownerCaller, "t", undefined);
		expect(queued[0][3]).toEqual({ reread: true });
		await collections.knowledgeDocuments.updateOne(
			{ _id: documentId },
			{ $set: { status: "ready" } }
		);
		await svc.rereadDocument(storeId, documentId.toString(), ownerCaller, "t", "");
		expect(queued[1][3]).toEqual({ reread: true, reader: null, readerLocal: undefined });
	});

	it("refuses a viewer and a stranger with 404, queueing nothing", async () => {
		const { storeId, documentId } = await seed();
		await expect(
			svc.rereadDocument(storeId, documentId.toString(), viewer, "t", "docling")
		).rejects.toMatchObject({ status: 404 });
		await expect(
			svc.rereadDocument(storeId, documentId.toString(), stranger, "t", "docling")
		).rejects.toMatchObject({ status: 404 });
		expect(queued).toEqual([]);
	});

	it("a document of another base is a 404", async () => {
		const a = await seed();
		const b = await seed();
		await expect(
			svc.rereadDocument(b.storeId, a.documentId.toString(), ownerCaller, "t", "docling")
		).rejects.toMatchObject({ status: 404 });
		expect(queued).toEqual([]);
	});

	it("a reader the user may not use, or a non-string, is a 400 and leaves the document unchanged", async () => {
		const { storeId, documentId } = await seed();
		for (const bad of ["not-mine", 7, { a: 1 }]) {
			await expect(
				svc.rereadDocument(storeId, documentId.toString(), ownerCaller, "t", bad)
			).rejects.toMatchObject({ status: 400 });
		}
		const row = await collections.knowledgeDocuments.findOne({ _id: documentId });
		expect(row?.status).toBe("ready");
		expect(row?.text).toBe("old text");
		expect(queued).toEqual([]);
	});

	it("a second click while it is queued is a 409", async () => {
		const { storeId, documentId } = await seed();
		await svc.rereadDocument(storeId, documentId.toString(), ownerCaller, "t", "docling");
		await expect(
			svc.rereadDocument(storeId, documentId.toString(), ownerCaller, "t", "docling")
		).rejects.toMatchObject({ status: 409 });
		expect(queued).toHaveLength(1);
	});

	it("a text-only document is refused with 400", async () => {
		const { storeId, textId } = await seed();
		await expect(
			svc.rereadDocument(storeId, textId.toString(), ownerCaller, "t", "docling")
		).rejects.toMatchObject({ status: 400 });
		expect(queued).toEqual([]);
	});
});
