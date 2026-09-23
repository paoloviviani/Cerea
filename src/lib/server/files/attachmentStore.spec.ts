/**
 * The owner-keyed attachment store against the real bucket: storing and
 * finding by owner key and message, owner-tag isolation, prefix deletion,
 * and that chat's own entries are untouched by any of it.
 *
 * Extraction is mocked (it would call the gateway); `isExtractableDocument`
 * stays real so which files get a text entry is decided as in production.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("$lib/server/files/extractDocument", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./extractDocument")>();
	return {
		...actual,
		extractDocument: vi.fn(async () => ({ ok: true, text: "# extracted text", pages: 3 })),
	};
});

import { collections, ready } from "$lib/server/database";
import {
	deleteAttachments,
	deleteAttachmentsByPrefix,
	findAttachments,
	isOwnerKey,
	readAttachment,
	storeAttachment,
} from "./attachmentStore";
import { uploadFile } from "./uploadFile";
import { deleteConversationAttachments } from "./deleteConversationAttachments";
import type { Conversation } from "$lib/types/Conversation";

beforeAll(async () => {
	await ready;
});

/** Every owner key a test used, cleaned up through the module under test. */
const deviceIds: string[] = [];
const conversations: ObjectId[] = [];

function freshDevice(): string {
	const id = new ObjectId().toHexString();
	deviceIds.push(id);
	return id;
}

afterEach(async () => {
	for (const id of deviceIds.splice(0)) await deleteAttachmentsByPrefix(`code:${id}:`);
	await deleteConversationAttachments(conversations.splice(0));
});

function rowsFor(owner: string) {
	return collections.bucket.find({ "metadata.conversation": owner }).toArray();
}

const png = () =>
	new File([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")], "shot.png", {
		type: "image/png",
	});

describe("owner keys", () => {
	it("accepts namespaced keys and refuses a bare conversation id", () => {
		expect(isOwnerKey("code:0123456789abcdef01234567:ses_1")).toBe(true);
		expect(isOwnerKey(new ObjectId().toHexString())).toBe(false);
		expect(isOwnerKey("code:")).toBe(false);
		expect(isOwnerKey("Code:x")).toBe(false);
	});

	it("refuses to store under a key that could name a chat conversation", async () => {
		await expect(storeAttachment(png(), new ObjectId().toHexString(), "m1")).rejects.toThrow(
			/namespaced/
		);
	});

	it("refuses a prefix that is not namespaced or does not end at a separator", async () => {
		await expect(deleteAttachmentsByPrefix("")).rejects.toThrow();
		await expect(deleteAttachmentsByPrefix("code:abc")).rejects.toThrow();
		await expect(deleteAttachmentsByPrefix(".*")).rejects.toThrow();
	});
});

describe("storeAttachment / findAttachments", () => {
	it("stores under the owner key and finds by message, in order", async () => {
		const key = `code:${freshDevice()}:ses_a`;
		const first = await storeAttachment(png(), key, "msg-1");
		const text = new File(["hello"], "notes.txt", { type: "text/plain" });
		const second = await storeAttachment(text, key, "msg-1");
		await storeAttachment(new File(["other"], "o.txt", { type: "text/plain" }), key, "msg-2");

		expect(first).toMatchObject({ type: "hash", mime: "image/png", name: "shot.png" });
		expect(await findAttachments(key, "msg-1")).toEqual([first, second]);
		expect(await findAttachments(key, "msg-2")).toHaveLength(1);
		expect(await findAttachments(key, "msg-3")).toEqual([]);

		const [row] = (await rowsFor(key)).filter((r) => r.metadata?.sha === first.value);
		expect(row.filename).toBe(`${key}-${first.value}`);
		expect(row.metadata).toMatchObject({
			conversation: key,
			mime: "image/png",
			messageId: "msg-1",
		});
	});

	it("folds a document's extracted text into its MessageFile, as upload returned it", async () => {
		const key = `code:${freshDevice()}:ses_doc`;
		const pdf = new File([Buffer.from("%PDF-1.4\n%pretend")], "spec.pdf", {
			type: "application/pdf",
		});
		const stored = await storeAttachment(pdf, key, "msg-doc");
		expect(stored.extracted?.pages).toBe(3);
		expect(await findAttachments(key, "msg-doc")).toEqual([stored]);
		expect(await rowsFor(key)).toHaveLength(2);

		const text = await readAttachment(stored.extracted?.value ?? "", key);
		expect(Buffer.from(text.value, "base64").toString()).toBe("# extracted text");
	});

	it("does not serve one key's file under another key", async () => {
		const key = `code:${freshDevice()}:ses_a`;
		const other = `code:${freshDevice()}:ses_a`;
		const stored = await storeAttachment(png(), key, "m");
		await expect(readAttachment(stored.value, key)).resolves.toMatchObject({ mime: "image/png" });
		await expect(readAttachment(stored.value, other)).rejects.toMatchObject({ status: 404 });
	});
});

describe("deletion", () => {
	it("deletes one session's files by key, and every session's by device prefix", async () => {
		const device = freshDevice();
		const neighbour = freshDevice();
		await storeAttachment(png(), `code:${device}:ses_1`, "m");
		await storeAttachment(png(), `code:${device}:ses_2`, "m");
		await storeAttachment(png(), `code:${neighbour}:ses_1`, "m");

		expect(await deleteAttachments(`code:${device}:ses_1`)).toBe(1);
		expect(await rowsFor(`code:${device}:ses_2`)).toHaveLength(1);

		expect(await deleteAttachmentsByPrefix(`code:${device}:`)).toBe(1);
		expect(await rowsFor(`code:${device}:ses_2`)).toHaveLength(0);
		expect(await rowsFor(`code:${neighbour}:ses_1`)).toHaveLength(1);
	});

	it("leaves chat's entries exactly as chat writes them, and never deletes them", async () => {
		const convId = new ObjectId();
		conversations.push(convId);
		const chatFile = await uploadFile(png(), { _id: convId } as Conversation);
		const [chatRow] = await rowsFor(convId.toString());
		// Chat's metadata shape is unchanged by the shared writer.
		expect(chatRow.metadata).toEqual({ conversation: convId.toString(), mime: "image/png" });
		expect(chatRow.filename).toBe(`${convId}-${chatFile.value}`);

		const device = freshDevice();
		await storeAttachment(png(), `code:${device}:s`, "m");
		await deleteAttachmentsByPrefix(`code:${device}:`);
		expect(await rowsFor(convId.toString())).toHaveLength(1);
	});
});
