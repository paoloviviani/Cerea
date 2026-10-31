import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { deleteConversationAttachments } from "./deleteConversationAttachments";
import { countBlobs, findBlobs, putBlob } from "$lib/server/blobs/testing";

beforeAll(async () => {
	await ready;
});

/**
 * Cleaned up through the module under test rather than a bucket-wide wipe:
 * every spec file shares one Mongo under TEST_MONGODB_URL, so deleting
 * everything here would race another file's assertions.
 */
let created: ObjectId[] = [];

afterEach(async () => {
	await deleteConversationAttachments(created);
	created = [];
});

async function store(
	filename: string,
	bytes: Buffer,
	metadata: Record<string, unknown>
): Promise<void> {
	await putBlob(filename, metadata, bytes);
}

function countFor(conversationId: ObjectId): Promise<number> {
	return countBlobs({ "metadata.conversation": conversationId.toString() });
}

describe("deleteConversationAttachments", () => {
	it("removes an attachment and its extracted text together", async () => {
		const convId = new ObjectId();
		created.push(convId);

		// What uploadFile writes: the document's bytes, then the markdown the
		// extractor read out of it, each keyed by its own sha.
		await store(`${convId}-bytes-sha`, Buffer.from("%PDF-1.4 pretend"), {
			conversation: convId.toString(),
			mime: "application/pdf",
		});
		await store(`${convId}-text-sha`, Buffer.from("# extracted"), {
			conversation: convId.toString(),
			mime: "text/markdown",
		});
		expect(await countFor(convId)).toBe(2);

		await deleteConversationAttachments(convId);

		expect(await countFor(convId)).toBe(0);
	});

	it("takes the bytes, not just the file entry", async () => {
		const convId = new ObjectId();
		created.push(convId);
		// Deliberately larger than one 255KB GridFS chunk, so the file spans
		// several: deleting the index row alone would drop the entry
		// and leave these behind, which is the orphaning this exists to end.
		// Asserted by reading rather than by counting chunk documents — the
		// chunks collection has no typed handle on the bucket, and "can the
		// bytes still be fetched" is the question that actually matters.
		await store(`${convId}-big-sha`, Buffer.alloc(700 * 1024, 7), {
			conversation: convId.toString(),
			mime: "application/pdf",
		});
		const [file] = await findBlobs({ "metadata.conversation": convId.toString() });

		const readBack = await new Promise<number>((resolve, reject) => {
			let bytes = 0;
			collections.blobStore.open("files", file.id).then((stream) => {
				stream.on("data", (chunk: Buffer) => (bytes += chunk.length));
				stream.on("error", reject);
				stream.on("end", () => resolve(bytes));
			}, reject);
		});
		expect(readBack).toBe(700 * 1024);

		await deleteConversationAttachments(convId);

		await expect(collections.blobStore.read("files", file.id)).rejects.toThrow();
	});

	it("touches nothing belonging to another conversation", async () => {
		const mine = new ObjectId();
		const theirs = new ObjectId();
		created.push(mine, theirs);
		await store(`${mine}-a`, Buffer.from("mine"), {
			conversation: mine.toString(),
			mime: "text/plain",
		});
		await store(`${theirs}-a`, Buffer.from("theirs"), {
			conversation: theirs.toString(),
			mime: "text/plain",
		});

		await deleteConversationAttachments(mine);

		expect(await countFor(mine)).toBe(0);
		expect(await countFor(theirs)).toBe(1);
	});

	it("leaves knowledge-base documents alone", async () => {
		const convId = new ObjectId();
		const owner = new ObjectId();
		created.push(convId);
		await store(`${convId}-a`, Buffer.from("attachment"), {
			conversation: convId.toString(),
			mime: "application/pdf",
		});
		// The same bucket holds knowledge documents under their original
		// filenames, tagged with an owner and no conversation. Deleting by
		// filename prefix instead of metadata would eventually take these.
		await store("quarterly-report.pdf", Buffer.from("knowledge"), {
			owner: owner.toString(),
			mime: "application/pdf",
		});

		await deleteConversationAttachments(convId);

		expect(await countFor(convId)).toBe(0);
		const kb = await findBlobs({ "metadata.owner": owner.toString() });
		expect(kb).toHaveLength(1);
		await collections.blobStore.delete("files", kb[0].id);
	});

	it("accepts a batch, for the bulk delete routes", async () => {
		const a = new ObjectId();
		const b = new ObjectId();
		created.push(a, b);
		await store(`${a}-x`, Buffer.from("a"), { conversation: a.toString(), mime: "text/plain" });
		await store(`${b}-x`, Buffer.from("b"), { conversation: b.toString(), mime: "text/plain" });

		await deleteConversationAttachments([a, b]);

		expect(await countFor(a)).toBe(0);
		expect(await countFor(b)).toBe(0);
	});

	it("does nothing, and does not throw, for an empty list", async () => {
		await expect(deleteConversationAttachments([])).resolves.toBeUndefined();
	});
});
