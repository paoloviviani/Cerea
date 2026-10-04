/**
 * What a conversation leaves behind outside its own document, against the
 * real database: its share links and their copied files, the files the daily
 * sweep finds when nothing else removed them, and the boot-time link of old
 * shares to their conversations. Routes are covered where they live
 * (`api/__tests__`, `projects`).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready, backfillSharedConversationIds } from "$lib/server/database";
import { cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import type { SharedConversation } from "$lib/types/SharedConversation";
import { deleteConversationStorage } from "./conversationStorage";
import { ATTACHMENT_GRACE_MS, sweepOrphanAttachments } from "./files/orphanAttachments";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
	await collections.codeDevices.deleteMany({});
});

async function storeFile(owner: string, name = `${owner}-sha`, uploadDate?: Date) {
	const upload = collections.bucket.openUploadStream(name, { metadata: { conversation: owner } });
	upload.end(Buffer.from("bytes"));
	await new Promise((resolve) => upload.once("finish", resolve));
	const id = upload.id as ObjectId;
	if (uploadDate) await collections.bucketFiles.updateOne({ _id: id }, { $set: { uploadDate } });
	return id;
}

const filesOf = (owner: string) =>
	collections.bucketFiles.countDocuments({ "metadata.conversation": owner });

function share(id: string, over: Partial<SharedConversation> = {}): SharedConversation {
	return {
		_id: id,
		hash: `hash-${id}`,
		createdAt: new Date(),
		updatedAt: new Date(),
		rootMessageId: "root",
		messages: [],
		title: "shared",
		model: "m",
		...over,
	};
}

async function conversation(userId = new ObjectId(), messageId = crypto.randomUUID()) {
	const _id = new ObjectId();
	await collections.conversations.insertOne({
		_id,
		title: "t",
		model: "m",
		userId,
		createdAt: new Date(),
		updatedAt: new Date(),
		rootMessageId: messageId,
		messages: [{ id: messageId, from: "user", content: "hi" }],
	} as never);
	return { _id, userId, messageId };
}

describe("deleting a conversation deletes its share links", () => {
	it("removes the share row and the files copied under the share id, and no other share", async () => {
		const conv = await conversation();
		const other = await conversation();
		await collections.sharedConversations.insertMany([
			share("sharedA", { conversationId: conv._id }),
			share("sharedB", { conversationId: other._id }),
		]);
		await storeFile(conv._id.toString());
		await storeFile("sharedA");
		await storeFile("sharedB");

		await deleteConversationStorage(conv._id);

		expect(await collections.sharedConversations.countDocuments({ _id: "sharedA" as never })).toBe(
			0
		);
		expect(await filesOf(conv._id.toString())).toBe(0);
		expect(await filesOf("sharedA")).toBe(0);
		expect(await collections.sharedConversations.countDocuments({ _id: "sharedB" as never })).toBe(
			1
		);
		expect(await filesOf("sharedB")).toBe(1);
	});
});

describe("backfillSharedConversationIds", () => {
	it("links a legacy share to the one conversation of its owner that carries its root message", async () => {
		const conv = await conversation();
		await collections.sharedConversations.insertOne(
			share("legacy1", { rootMessageId: conv.messageId, userId: conv.userId })
		);

		const result = await backfillSharedConversationIds(
			collections.sharedConversations,
			collections.conversations
		);

		expect(result.linked).toBe(1);
		const row = await collections.sharedConversations.findOne({ _id: "legacy1" as never });
		expect(row?.conversationId?.toString()).toBe(conv._id.toString());
	});

	it("leaves a share alone when two conversations carry the message, or none does", async () => {
		const userId = new ObjectId();
		const first = await conversation(userId);
		// A conversation started from a share keeps the root message id.
		const copy = await conversation(userId, first.messageId);
		expect(copy.messageId).toBe(first.messageId);
		await collections.sharedConversations.insertMany([
			share("ambig", { rootMessageId: first.messageId, userId }),
			share("nobody", { rootMessageId: "gone", userId }),
			share("unowned", { rootMessageId: first.messageId }),
		]);

		const result = await backfillSharedConversationIds(
			collections.sharedConversations,
			collections.conversations
		);

		expect(result.linked).toBe(0);
		expect(
			await collections.sharedConversations.countDocuments({ conversationId: { $exists: true } })
		).toBe(0);
	});
});

describe("sweepOrphanAttachments", () => {
	const old = () => new Date(Date.now() - ATTACHMENT_GRACE_MS - 60_000);

	it("removes old files of a conversation that no longer exists, and keeps a live one's", async () => {
		const live = await conversation();
		const deadId = new ObjectId().toString();
		await storeFile(live._id.toString(), "live", old());
		await storeFile(deadId, "dead1", old());
		await storeFile(deadId, "dead2", old());

		const counts = await sweepOrphanAttachments();

		expect(counts.files).toBe(2);
		expect(await filesOf(deadId)).toBe(0);
		expect(await filesOf(live._id.toString())).toBe(1);
	});

	it("leaves a young orphan alone: its upload may be racing the conversation's creation", async () => {
		const deadId = new ObjectId().toString();
		await storeFile(deadId, "fresh");

		const counts = await sweepOrphanAttachments();

		expect(counts.files).toBe(0);
		expect(await filesOf(deadId)).toBe(1);
		// A day and a bit later it is an orphan.
		await sweepOrphanAttachments(new Date(Date.now() + ATTACHMENT_GRACE_MS + 60_000));
		expect(await filesOf(deadId)).toBe(0);
	});

	it("removes share copies whose share is gone, keeps those whose share is live", async () => {
		await collections.sharedConversations.insertOne(share("liveShr"));
		await storeFile("liveShr", "a", old());
		await storeFile("goneShr", "b", old());

		await sweepOrphanAttachments();

		expect(await filesOf("liveShr")).toBe(1);
		expect(await filesOf("goneShr")).toBe(0);
	});

	it("removes a share, and its copies, whose source conversation is gone", async () => {
		const conv = await conversation();
		const goneConv = new ObjectId();
		await collections.sharedConversations.insertMany([
			share("keepShr", { conversationId: conv._id }),
			share("dropShr", { conversationId: goneConv }),
		]);
		await storeFile("keepShr", "a", old());
		await storeFile("dropShr", "b", old());

		const counts = await sweepOrphanAttachments();

		expect(counts.shares).toBe(1);
		expect(await collections.sharedConversations.countDocuments({ _id: "dropShr" as never })).toBe(
			0
		);
		expect(await filesOf("dropShr")).toBe(0);
		expect(await collections.sharedConversations.countDocuments({ _id: "keepShr" as never })).toBe(
			1
		);
		expect(await filesOf("keepShr")).toBe(1);
	});

	it("code keys: gone with the device, kept while it is paired", async () => {
		const liveDevice = new ObjectId();
		await collections.codeDevices.insertOne({ _id: liveDevice } as never);
		const goneDevice = new ObjectId();
		await storeFile(`code:${liveDevice}:ses_1`, "a", old());
		await storeFile(`code:${goneDevice}:ses_1`, "b", old());

		await sweepOrphanAttachments();

		expect(await filesOf(`code:${liveDevice}:ses_1`)).toBe(1);
		expect(await filesOf(`code:${goneDevice}:ses_1`)).toBe(0);
	});

	it("never touches a tag it does not recognise, or a knowledge upload", async () => {
		await storeFile("some-other-tag", "a", old());
		const upload = collections.bucket.openUploadStream("kb.pdf", { metadata: { owner: "u1" } });
		upload.end(Buffer.from("kb"));
		await new Promise((resolve) => upload.once("finish", resolve));
		await collections.bucketFiles.updateOne(
			{ _id: upload.id as ObjectId },
			{ $set: { uploadDate: old() } }
		);

		const counts = await sweepOrphanAttachments();

		expect(counts.files).toBe(0);
		expect(await filesOf("some-other-tag")).toBe(1);
		expect(await collections.bucketFiles.countDocuments({ "metadata.owner": "u1" })).toBe(1);
	});
});
