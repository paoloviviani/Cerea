import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	KnowledgeError,
	MAX_DOWNLOAD_BYTES,
	readDocumentDownload,
	readDocumentPreview,
	readDocumentText,
	storeUpload,
	type Caller,
} from "./service";

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

/** GridFS files this file stored, so the afterEach can remove them. */
const uploadedFileIds: ObjectId[] = [];

async function storeBytes(name: string, text: string, mime = "text/plain") {
	const stored = await storeUpload({ name, bytes: Buffer.from(text, "utf8"), mime }, owner.userId);
	uploadedFileIds.push(new ObjectId(stored.id));
	return stored;
}

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
	for (const id of uploadedFileIds.splice(0)) {
		await collections.bucket.delete(id).catch(() => undefined);
	}
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

describe("readDocumentPreview", () => {
	it("returns the stored markdown to the owner without re-extracting", async () => {
		// The row already carries the text extraction wrote; the preview reads
		// it back rather than calling the reader again (billing, not caching).
		const doc = await insertDocument({ text: "# Q3\n\nUp 12%.\n", filename: "q3.md" });
		const result = await readDocumentPreview(storeId.toString(), doc.insertedId.toString(), owner);
		expect(result.text).toBe("# Q3\n\nUp 12%.\n");
		expect(result.title).toBe("Q3 numbers");
		expect(result.filename).toBe("q3.md");
	});

	it("serves shared viewers but not strangers", async () => {
		const doc = await insertDocument({ text: "hello" });
		const shared = await readDocumentPreview(storeId.toString(), doc.insertedId.toString(), viewer);
		expect(shared.text).toBe("hello");
		await expect(
			readDocumentPreview(storeId.toString(), doc.insertedId.toString(), stranger)
		).rejects.toMatchObject({ status: 404 });
	});

	it("refuses a document whose text has not landed yet", async () => {
		const doc = await insertDocument({ status: "pending", text: undefined });
		await expect(
			readDocumentPreview(storeId.toString(), doc.insertedId.toString(), owner)
		).rejects.toMatchObject({ status: 409 });
	});

	it("404s a malformed document id rather than throwing the driver's error", async () => {
		await expect(readDocumentPreview(storeId.toString(), "not-an-id", owner)).rejects.toMatchObject(
			{ status: 404 }
		);
	});
});

describe("readDocumentDownload", () => {
	it("returns the original bytes to the owner", async () => {
		const stored = await storeBytes("report.pdf", "%PDF-original-bytes", "application/pdf");
		const doc = await insertDocument({
			text: "# extracted\n",
			filename: "report.pdf",
			fileId: new ObjectId(stored.id),
		});
		const result = await readDocumentDownload(storeId.toString(), doc.insertedId.toString(), owner);
		expect(result.bytes.toString("utf8")).toBe("%PDF-original-bytes");
		expect(result.filename).toBe("report.pdf");
		expect(result.mime).toBe("application/pdf");
		expect(result.size).toBe(Buffer.byteLength("%PDF-original-bytes"));
	});

	it("serves shared viewers but not strangers", async () => {
		const stored = await storeBytes("notes.txt", "shared words");
		const doc = await insertDocument({
			text: "shared words",
			filename: "notes.txt",
			fileId: new ObjectId(stored.id),
		});
		const shared = await readDocumentDownload(
			storeId.toString(),
			doc.insertedId.toString(),
			viewer
		);
		expect(shared.bytes.toString("utf8")).toBe("shared words");
		await expect(
			readDocumentDownload(storeId.toString(), doc.insertedId.toString(), stranger)
		).rejects.toMatchObject({ status: 404 });
	});

	it("404s a text-only document, which has no original bytes", async () => {
		const doc = await insertDocument({ text: "a pasted note" });
		await expect(
			readDocumentDownload(storeId.toString(), doc.insertedId.toString(), owner)
		).rejects.toMatchObject({ status: 404 });
	});

	it("404s when the stored bytes are gone", async () => {
		const stored = await storeBytes("gone.txt", "vanished");
		const doc = await insertDocument({
			text: "vanished",
			filename: "gone.txt",
			fileId: new ObjectId(stored.id),
		});
		await collections.bucket.delete(new ObjectId(stored.id));
		uploadedFileIds.pop();
		await expect(
			readDocumentDownload(storeId.toString(), doc.insertedId.toString(), owner)
		).rejects.toMatchObject({ status: 404 });
	});

	it("refuses a file over the download cap before streaming it", async () => {
		const stored = await storeBytes("big.bin", "small on disk, huge on paper");
		const doc = await insertDocument({
			text: "big",
			filename: "big.bin",
			fileId: new ObjectId(stored.id),
		});
		// The cap guards what the download returns, not how the bytes got
		// there: a stubbed directory entry is enough to prove the refusal
		// lands before the stream is opened.
		const find = vi.spyOn(collections.bucket, "find").mockReturnValue({
			next: async () => ({
				length: MAX_DOWNLOAD_BYTES + 1,
				filename: "big.bin",
				metadata: { mime: "application/octet-stream" },
			}),
		} as never);
		try {
			await expect(
				readDocumentDownload(storeId.toString(), doc.insertedId.toString(), owner)
			).rejects.toMatchObject({ status: 413 });
		} finally {
			find.mockRestore();
		}
	});

	it("404s a document from another store and a malformed id", async () => {
		const stored = await storeBytes("secret.txt", "secret");
		const doc = await insertDocument({
			text: "secret",
			filename: "secret.txt",
			fileId: new ObjectId(stored.id),
		});
		await expect(
			readDocumentDownload(new ObjectId().toString(), doc.insertedId.toString(), owner)
		).rejects.toMatchObject({ status: 404 });
		await expect(
			readDocumentDownload(storeId.toString(), "not-an-id", owner)
		).rejects.toMatchObject({ status: 404 });
	});
});
