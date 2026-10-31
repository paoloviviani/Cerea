/**
 * What a knowledge base accepts, decided from the bytes. Real Mongo (GridFS):
 * `TEST_MONGODB_URL=… npx vitest run --project=server --no-file-parallelism`.
 */
import { describe, expect, it, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import { putBlob } from "$lib/server/blobs/testing";
import { collections, ready } from "$lib/server/database";
import { ingestDocument, storeUpload } from "./service";
import { decodeText } from "$lib/server/files/knowledgeUpload";

await ready;

const owner = new ObjectId();
const stored: ObjectId[] = [];

// Minimal real signatures: file-type reads the leading bytes only.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4", "hex");
const ZIP = Buffer.from("504b0304140000000000000000000000000000000000000000000000", "hex");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const ELF = Buffer.from("7f454c4602010100000000000000000002003e00", "hex");

async function put(name: string, bytes: Buffer, mime = "application/octet-stream") {
	const result = await storeUpload({ name, bytes, mime }, owner);
	stored.push(new ObjectId(result.id));
	return result;
}

async function storedMime(id: string) {
	const file = await collections.blobStore.stat("files", new ObjectId(id));
	return file?.metadata.mime as string;
}

afterEach(async () => {
	for (const id of stored.splice(0))
		await collections.blobStore.delete("files", id).catch(() => undefined);
	await collections.vectorStores.deleteMany({});
	await collections.knowledgeDocuments.deleteMany({});
});

describe("storeUpload refuses what a knowledge base cannot index", () => {
	it("refuses an image with 415, whatever the browser said", async () => {
		await expect(put("photo.png", PNG, "text/plain")).rejects.toMatchObject({
			status: 415,
			message: expect.stringContaining("Accepted: PDF, Word, Excel"),
		});
	});

	it("refuses a zip and an executable", async () => {
		await expect(put("bundle.zip", ZIP, "application/zip")).rejects.toMatchObject({ status: 415 });
		await expect(put("tool", ELF, "text/plain")).rejects.toMatchObject({ status: 415 });
	});

	it("refuses bytes that are not valid UTF-8 text", async () => {
		await expect(
			put("blob.txt", Buffer.from([0x68, 0xff, 0xfe, 0x00, 0x01]))
		).rejects.toMatchObject({ status: 415 });
	});

	it("accepts markdown and csv, storing a text type", async () => {
		const md = await put("notes.md", Buffer.from("# Title\n\nbody\n"), "application/octet-stream");
		const csv = await put("data.csv", Buffer.from("a,b\n1,2\n"), "application/octet-stream");
		expect(await storedMime(md.id)).toBe("text/markdown");
		expect(await storedMime(csv.id)).toBe("text/csv");
	});

	it("accepts a PDF, and a docx by what its bytes and name say", async () => {
		const pdf = await put("a.pdf", PDF, "text/plain");
		expect(await storedMime(pdf.id)).toBe("application/pdf");
		const docx = await put("a.docx", ZIP, "application/octet-stream");
		expect(await storedMime(docx.id)).toContain("wordprocessingml");
	});

	it("accepts text the browser called an image, by sniffing", async () => {
		const note = await put("readme", Buffer.from("just words\n"), "image/png");
		expect(await storedMime(note.id)).toBe("text/plain");
	});
});

const CSV_1252 = Buffer.from([...Buffer.from("name,caf"), 0xe9, ...Buffer.from(",1\n")]);

describe("text encodings", () => {
	it("accepts a windows-1252 CSV and decodes its accents", async () => {
		const up = await put("export.csv", CSV_1252, "application/vnd.ms-excel");
		expect(await storedMime(up.id)).toBe("text/csv");
		expect(decodeText(CSV_1252)).toBe("name,caf\u00e9,1\n");
	});

	it("accepts a UTF-8 file with a BOM and strips it", async () => {
		const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n\u00e9,2\n")]);
		await put("bom.csv", bom);
		expect(decodeText(bom)).toBe("a,b\n\u00e9,2\n");
	});

	it("still refuses real binary, and says UTF-16 is an encoding problem", async () => {
		expect(decodeText(ELF)).toBeNull();
		expect(decodeText(Buffer.from([0x80, 0x81, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))).toBeNull();
		const utf16 = Buffer.from("\ufeffa,b\n", "utf16le");
		await expect(put("excel.txt", utf16)).rejects.toMatchObject({
			status: 415,
			message: expect.stringContaining("save as UTF-8"),
		});
	});

	it("indexes a stored windows-1252 file with its accents", async () => {
		const row = await ingestStored("old.csv", CSV_1252);
		const doc = await collections.knowledgeDocuments.findOne({ _id: row.documentId });
		expect(doc?.text).toContain("caf\u00e9");
	});
});

async function ingestStored(name: string, bytes: Buffer) {
	const id = new ObjectId();
	await putBlob(name, { mime: "text/csv", owner: owner.toString() }, bytes, "files", id);
	stored.push(id);
	const storeId = new ObjectId();
	await collections.vectorStores.insertOne({
		_id: storeId,
		name: "kb",
		description: "",
		ownerId: owner,
		embeddingModel: "test-embedder",
		dimensions: null,
		chunkChars: 1200,
		chunkOverlap: 150,
		shares: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	const documentId = new ObjectId();
	await collections.knowledgeDocuments.insertOne({
		_id: documentId,
		storeId,
		title: name,
		filename: name,
		fileId: id,
		status: "pending",
		chars: 0,
		chunkCount: 0,
		error: "",
		embeddingModel: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	// Embedding is not configured here, so indexing fails after the text is read.
	await ingestDocument(documentId, "t").catch(() => undefined);
	return { documentId };
}

describe("ingest of a stored binary", () => {
	it("fails that document with the reason, without throwing", async () => {
		// Written straight to GridFS, as an older upload would have been.
		const id = new ObjectId();
		await putBlob(
			"old.bin",
			{ mime: "application/octet-stream", owner: owner.toString() },
			ELF,
			"files",
			id
		);
		stored.push(id);
		const storeId = new ObjectId();
		await collections.vectorStores.insertOne({
			_id: storeId,
			name: "kb",
			description: "",
			ownerId: owner,
			embeddingModel: "test-embedder",
			dimensions: null,
			chunkChars: 1200,
			chunkOverlap: 150,
			shares: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const documentId = new ObjectId();
		await collections.knowledgeDocuments.insertOne({
			_id: documentId,
			storeId,
			title: "old.bin",
			filename: "old.bin",
			fileId: id,
			status: "pending",
			chars: 0,
			chunkCount: 0,
			error: "",
			embeddingModel: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const row = await ingestDocument(documentId, "t");
		expect(row.status).toBe("failed");
		expect(row.error).toContain("not text");
		expect(row.error).toContain("Accepted:");
	});
});
