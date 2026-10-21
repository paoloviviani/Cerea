import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";

// Gotenberg is the one thing replaced: the store, the bucket and Mongo are real.
const convert = vi.hoisted(() => vi.fn());
const enabled = vi.hoisted(() => ({ on: true }));
vi.mock("./gotenberg", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./gotenberg")>();
	return {
		...actual,
		convertOfficeToPdf: convert,
		isGotenbergEnabled: () => enabled.on,
	};
});

const {
	getOrCreatePreview,
	previewFilename,
	previewInBackground,
	previewOwner,
	releasePreviewOwners,
	releasePreviewOwnerStrings,
	sourceSha256,
	sweepOrphanPreviews,
	wantsEagerPreview,
} = await import("./previewStore");
const { CONVERTER_VERSION } = await import("./gotenberg");
const { deleteConversationAttachments } =
	await import("$lib/server/files/deleteConversationAttachments");
const { deleteConversationDeliverables, storeDeliverable, sweepExpiredDeliverables } =
	await import("$lib/server/execution/deliverables");
const { USER_KEYED_COLLECTIONS } = await import("$lib/server/identity/userKeyedCollections");

beforeAll(async () => {
	await ready;
});

let conversations: ObjectId[] = [];
let shas: string[] = [];
function newConversation(): ObjectId {
	const id = new ObjectId();
	conversations.push(id);
	return id;
}
/** Distinct bytes per call, so tests never share a preview by accident. */
function bytesOf(label: string): Buffer {
	const bytes = Buffer.from(`${label}-${new ObjectId()}`);
	shas.push(sourceSha256(bytes));
	return bytes;
}
const pdfOf = (text: string) => Buffer.from(`%PDF-1.7\n${text}`);

beforeEach(() => {
	convert.mockReset();
	convert.mockImplementation(async (bytes: Uint8Array) => pdfOf(Buffer.from(bytes).toString()));
	enabled.on = true;
});

afterEach(async () => {
	await deleteConversationAttachments(conversations);
	await deleteConversationDeliverables(conversations);
	// Whatever a failed assertion left: precisely this test's previews.
	for (const sha of shas) {
		for (const version of [CONVERTER_VERSION, "gotenberg-old"]) {
			const rows = await collections.bucketFiles
				.find({ filename: previewFilename(sha, version) })
				.toArray();
			await Promise.all(rows.map((row) => collections.bucket.delete(row._id)));
		}
	}
	conversations = [];
	shas = [];
});

async function rowsFor(sha: string, version = CONVERTER_VERSION) {
	return collections.bucketFiles.find({ filename: previewFilename(sha, version) }).toArray();
}

/** A stored attachment as `writeAttachment` leaves it (the source a preview's owner names). */
async function storeAttachment(conversation: ObjectId, storedSha: string, bytes: Buffer) {
	const upload = collections.bucket.openUploadStream(`${conversation}-${storedSha}`, {
		metadata: { conversation: conversation.toString(), mime: "application/octet-stream" },
	});
	await new Promise<void>((resolve, reject) => {
		upload.once("finish", () => resolve());
		upload.once("error", reject);
		upload.end(bytes);
	});
}

describe("cache keying", () => {
	it("keys a preview by the converter version and the sha256 of the source bytes", async () => {
		const bytes = bytesOf("deck");
		const sha = sourceSha256(bytes);
		expect(previewFilename(sha)).toBe(`preview-${CONVERTER_VERSION}-${sha}`);
		await getOrCreatePreview({ bytes, name: "a.pptx", owner: "att:c1-s1" });
		const rows = await rowsFor(sha);
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata).toMatchObject({
			preview: true,
			version: CONVERTER_VERSION,
			sha256: sha,
		});
		// Not tagged as any conversation's file: nothing else may find, serve or delete it.
		expect(rows[0].metadata?.conversation).toBeUndefined();
	});

	it("shares one preview between identical files and converts once", async () => {
		const bytes = bytesOf("shared");
		const sha = sourceSha256(bytes);
		const first = await getOrCreatePreview({ bytes, name: "a.docx", owner: "att:c1-s1" });
		const second = await getOrCreatePreview({ bytes, name: "copy.docx", owner: "att:c2-s2" });
		expect(first.cached).toBe(false);
		expect(second.cached).toBe(true);
		expect(second.pdf.equals(first.pdf)).toBe(true);
		expect(convert).toHaveBeenCalledTimes(1);
		const rows = await rowsFor(sha);
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata?.owners).toEqual(["att:c1-s1", "att:c2-s2"]);
	});

	it("gives an edited file its own preview", async () => {
		const original = bytesOf("v1");
		const edited = Buffer.concat([original, Buffer.from(" edited")]);
		shas.push(sourceSha256(edited));
		const a = await getOrCreatePreview({ bytes: original, name: "a.docx", owner: "att:c-1" });
		const b = await getOrCreatePreview({ bytes: edited, name: "a.docx", owner: "att:c-2" });
		expect(convert).toHaveBeenCalledTimes(2);
		expect(b.pdf.equals(a.pdf)).toBe(false);
		expect(await rowsFor(sourceSha256(original))).toHaveLength(1);
		expect(await rowsFor(sourceSha256(edited))).toHaveLength(1);
	});

	it("invalidates previews of another converter version", async () => {
		const conversation = newConversation();
		const bytes = bytesOf("upgrade");
		const sha = sourceSha256(bytes);
		const owner = previewOwner("att", conversation.toString(), "stored-sha");
		await storeAttachment(conversation, "stored-sha", bytes);
		// A preview an earlier release made: same bytes, an older converter version.
		const upload = collections.bucket.openUploadStream(previewFilename(sha, "gotenberg-old"), {
			metadata: { preview: true, version: "gotenberg-old", sha256: sha, owners: [owner] },
		});
		await new Promise<void>((resolve) => upload.end(pdfOf("stale"), () => resolve()));

		const result = await getOrCreatePreview({ bytes, name: "a.docx", owner });
		expect(result.cached).toBe(false);
		expect(convert).toHaveBeenCalledTimes(1);
		expect(result.pdf.toString()).not.toContain("stale");
		// The sweep then drops the entry nothing reads any more.
		expect(await rowsFor(sha, "gotenberg-old")).toHaveLength(1);
		await sweepOrphanPreviews();
		expect(await rowsFor(sha, "gotenberg-old")).toHaveLength(0);
		expect(await rowsFor(sha)).toHaveLength(1);
	});

	it("converts a file once for concurrent first views", async () => {
		const bytes = bytesOf("race");
		convert.mockImplementation(async (b: Uint8Array) => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			return pdfOf(Buffer.from(b).toString());
		});
		await Promise.all([
			getOrCreatePreview({ bytes, name: "a.pptx", owner: "att:c-1" }),
			getOrCreatePreview({ bytes, name: "a.pptx", owner: "att:c-2" }),
			getOrCreatePreview({ bytes, name: "a.pptx", owner: "att:c-3" }),
		]);
		expect(convert).toHaveBeenCalledTimes(1);
		const rows = await rowsFor(sourceSha256(bytes));
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata?.owners?.sort()).toEqual(["att:c-1", "att:c-2", "att:c-3"]);
	});

	it("stores nothing when the conversion fails, and the next view tries again", async () => {
		const bytes = bytesOf("broken");
		convert.mockRejectedValueOnce(new Error("converter down"));
		await expect(getOrCreatePreview({ bytes, name: "a.docx", owner: "att:c-1" })).rejects.toThrow(
			"converter down"
		);
		expect(await rowsFor(sourceSha256(bytes))).toHaveLength(0);
		await expect(
			getOrCreatePreview({ bytes, name: "a.docx", owner: "att:c-1" })
		).resolves.toMatchObject({ cached: false });
	});
});

describe("lazy and eager conversion", () => {
	it("converts nothing until a preview is asked for", async () => {
		const conversation = newConversation();
		const bytes = bytesOf("upload");
		await storeAttachment(conversation, "stored-sha", bytes);
		expect(convert).not.toHaveBeenCalled();
		expect(await rowsFor(sourceSha256(bytes))).toHaveLength(0);

		await getOrCreatePreview({
			bytes,
			name: "a.docx",
			owner: previewOwner("att", conversation.toString(), "stored-sha"),
		});
		expect(convert).toHaveBeenCalledTimes(1);
	});

	it("converts a produced Office file straight away, in the background", async () => {
		const conversationId = newConversation();
		const bytes = bytesOf("generated-deck");
		const stored = await storeDeliverable({
			conversationId,
			name: "slides.pptx",
			mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			bytes,
		});
		expect(stored.ok).toBe(true);
		// storeDeliverable did not wait for it...
		await vi.waitFor(async () => expect(await rowsFor(sourceSha256(bytes))).toHaveLength(1));
		expect(convert).toHaveBeenCalledTimes(1);
		const rows = await rowsFor(sourceSha256(bytes));
		expect(rows[0].metadata?.owners).toEqual([
			previewOwner("out", conversationId.toString(), sourceSha256(bytes)),
		]);
	});

	it("leaves produced files that are not Office documents, and every file without a converter, alone", async () => {
		const conversationId = newConversation();
		await storeDeliverable({
			conversationId,
			name: "notes.txt",
			mime: "text/plain",
			bytes: bytesOf("text"),
		});
		enabled.on = false;
		await storeDeliverable({
			conversationId,
			name: "deck.pptx",
			mime: "application/octet-stream",
			bytes: bytesOf("deck-no-converter"),
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(convert).not.toHaveBeenCalled();
		expect(wantsEagerPreview("deck.pptx", 10)).toBe(false);
		enabled.on = true;
		expect(wantsEagerPreview("deck.pptx", 10)).toBe(true);
		expect(wantsEagerPreview("notes.txt", 10)).toBe(false);
		expect(wantsEagerPreview("huge.pptx", 50 * 1024 * 1024)).toBe(false);
	});

	it("forgets a failed eager conversion; the first view then converts", async () => {
		convert.mockRejectedValueOnce(new Error("down"));
		const bytes = bytesOf("eager-fails");
		previewInBackground({ bytes, name: "a.docx", owner: "out:c-1" });
		await vi.waitFor(() => expect(convert).toHaveBeenCalledTimes(1));
		expect(await rowsFor(sourceSha256(bytes))).toHaveLength(0);
		await expect(
			getOrCreatePreview({ bytes, name: "a.docx", owner: "out:c-1" })
		).resolves.toMatchObject({ cached: false });
	});
});

describe("cleanup", () => {
	it("deletes the preview with the last file that uses it, and not before", async () => {
		const first = newConversation();
		const second = newConversation();
		const bytes = bytesOf("two-owners");
		const sha = sourceSha256(bytes);
		await getOrCreatePreview({
			bytes,
			name: "a.docx",
			owner: previewOwner("att", first.toString(), "s1"),
		});
		await getOrCreatePreview({
			bytes,
			name: "a.docx",
			owner: previewOwner("att", second.toString(), "s2"),
		});

		await releasePreviewOwners("att", [first.toString()]);
		const rows = await rowsFor(sha);
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata?.owners).toEqual([previewOwner("att", second.toString(), "s2")]);

		await releasePreviewOwners("att", [second.toString()]);
		expect(await rowsFor(sha)).toHaveLength(0);
		// ...chunks and all.
		expect(await collections.bucketFiles.countDocuments({ _id: rows[0]._id })).toBe(0);
	});

	it("does not confuse one conversation with another that shares a prefix", async () => {
		const bytes = bytesOf("prefix");
		await getOrCreatePreview({ bytes, name: "a.docx", owner: "att:abc-s1" });
		await releasePreviewOwners("att", ["ab"]);
		expect(await rowsFor(sourceSha256(bytes))).toHaveLength(1);
		await releasePreviewOwners("att", ["abc"]);
		expect(await rowsFor(sourceSha256(bytes))).toHaveLength(0);
	});

	it("goes with the conversation's attachments", async () => {
		const conversation = newConversation();
		const bytes = bytesOf("attachment");
		await storeAttachment(conversation, "stored-sha", bytes);
		await getOrCreatePreview({
			bytes,
			name: "a.xlsx",
			owner: previewOwner("att", conversation.toString(), "stored-sha"),
		});
		expect(await rowsFor(sourceSha256(bytes))).toHaveLength(1);
		await deleteConversationAttachments(conversation);
		expect(await rowsFor(sourceSha256(bytes))).toHaveLength(0);
	});

	it("goes with the conversation's produced files, and keeps what another conversation still uses", async () => {
		const mine = newConversation();
		const theirs = newConversation();
		const bytes = bytesOf("produced");
		const sha = sourceSha256(bytes);
		for (const conversationId of [mine, theirs]) {
			await storeDeliverable({ conversationId, name: "deck.pptx", mime: "x/y", bytes });
		}
		await vi.waitFor(async () => {
			const rows = await rowsFor(sha);
			expect(rows[0]?.metadata?.owners).toHaveLength(2);
		});
		await deleteConversationDeliverables(mine);
		expect((await rowsFor(sha))[0].metadata?.owners).toEqual([
			previewOwner("out", theirs.toString(), sha),
		]);
		await deleteConversationDeliverables(theirs);
		expect(await rowsFor(sha)).toHaveLength(0);
	});

	it("goes when retention expires the file", async () => {
		const conversationId = newConversation();
		const bytes = bytesOf("expiring");
		const sha = sourceSha256(bytes);
		await storeDeliverable({ conversationId, name: "deck.pptx", mime: "x/y", bytes });
		await vi.waitFor(async () => expect(await rowsFor(sha)).toHaveLength(1));
		await collections.codeExecutionOutputs.updateMany(
			{ conversationId },
			{ $set: { createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) } }
		);
		await sweepExpiredDeliverables(Date.now(), 30);
		expect(await rowsFor(sha)).toHaveLength(0);
	});

	it("goes with an erased account's files", async () => {
		const userId = new ObjectId();
		const conversation = newConversation();
		const bytes = bytesOf("erased-attachment");
		await storeAttachment(conversation, "stored-sha", bytes);
		await getOrCreatePreview({
			bytes,
			name: "a.docx",
			owner: previewOwner("att", conversation.toString(), "stored-sha"),
		});
		const produced = newConversation();
		const deck = bytesOf("erased-deliverable");
		await storeDeliverable({
			conversationId: produced,
			userId,
			name: "deck.pptx",
			mime: "x/y",
			bytes: deck,
		});
		await vi.waitFor(async () => expect(await rowsFor(sourceSha256(deck))).toHaveLength(1));

		const entry = (name: string) => {
			const found = USER_KEYED_COLLECTIONS.find((e) => e.name === name);
			if (!found) throw new Error(`no entry ${name}`);
			return found;
		};
		await entry("bucket:conversationFiles").erase(userId, { conversationIds: [conversation] });
		await entry("codeExecutionOutputs").erase(userId, { conversationIds: [] });
		expect(await rowsFor(sourceSha256(bytes))).toHaveLength(0);
		expect(await rowsFor(sourceSha256(deck))).toHaveLength(0);
	});

	it("is swept when its source file vanished without telling the store", async () => {
		const conversation = newConversation();
		const kept = bytesOf("kept-source");
		const gone = bytesOf("gone-source");
		await storeAttachment(conversation, "kept", kept);
		const owner = (storedSha: string) => previewOwner("att", conversation.toString(), storedSha);
		await getOrCreatePreview({ bytes: kept, name: "a.docx", owner: owner("kept") });
		// "gone" has no stored source file at all.
		await getOrCreatePreview({ bytes: gone, name: "a.docx", owner: owner("gone") });
		// ...and one preview is shared by a live and a dead owner.
		await getOrCreatePreview({ bytes: kept, name: "a.docx", owner: owner("gone-too") });

		await sweepOrphanPreviews();
		expect(await rowsFor(sourceSha256(gone))).toHaveLength(0);
		const rows = await rowsFor(sourceSha256(kept));
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata?.owners).toEqual([owner("kept")]);
	});

	it("leaves an owner of a kind it does not know alone", async () => {
		const bytes = bytesOf("foreign");
		await getOrCreatePreview({ bytes, name: "a.docx", owner: "zzz:something-else" });
		await sweepOrphanPreviews();
		expect(await rowsFor(sourceSha256(bytes))).toHaveLength(1);
		await releasePreviewOwnerStrings(["zzz:something-else"]);
		expect(await rowsFor(sourceSha256(bytes))).toHaveLength(0);
	});
});
