/**
 * What a conversation leaves behind outside its own document, against the
 * real database: any legacy share links (read by raw collection name: the feature and its
 * typed handle are gone) and their copied files, and the files the daily
 * sweep finds when nothing else removed them. Routes are covered where they live
 * (`api/__tests__`, `projects`).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready, Database } from "$lib/server/database";
import { cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import { deleteConversationStorage } from "./conversationStorage";
import { ATTACHMENT_GRACE_MS, sweepOrphanAttachments } from "./files/orphanAttachments";
import { putBlob, setUploadDate } from "$lib/server/blobs/testing";

beforeAll(async () => {
	await ready;
}, 30000);

const shares = async () => (await Database.getInstance()).rawCollection("sharedConversations");

afterEach(async () => {
	await cleanupTestData();
	await (await shares()).deleteMany({});
	await collections.codeDevices.deleteMany({});
});

async function storeFile(owner: string, name = `${owner}-sha`, uploadDate?: Date) {
	const id = await putBlob(name, { conversation: owner });
	if (uploadDate) await setUploadDate(id, uploadDate);
	return id;
}

const filesOf = (owner: string) =>
	collections.blobStore.count("files", { "metadata.conversation": owner });

function share(id: string, over: Record<string, unknown> = {}) {
	return {
		_id: id as unknown as ObjectId,
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

describe("deleting a conversation deletes its legacy share links", () => {
	it("removes the share row and the files copied under the share id, and no other share", async () => {
		const conv = await conversation();
		const other = await conversation();
		await (
			await shares()
		).insertMany([
			share("sharedA", { conversationId: conv._id }),
			share("sharedB", { conversationId: other._id }),
		]);
		await storeFile(conv._id.toString());
		await storeFile("sharedA");
		await storeFile("sharedB");

		await deleteConversationStorage(conv._id);

		expect(await (await shares()).countDocuments({ _id: "sharedA" as never })).toBe(0);
		expect(await filesOf(conv._id.toString())).toBe(0);
		expect(await filesOf("sharedA")).toBe(0);
		expect(await (await shares()).countDocuments({ _id: "sharedB" as never })).toBe(1);
		expect(await filesOf("sharedB")).toBe(1);
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
		await (await shares()).insertOne(share("liveShr"));
		await storeFile("liveShr", "a", old());
		await storeFile("goneShr", "b", old());

		await sweepOrphanAttachments();

		expect(await filesOf("liveShr")).toBe(1);
		expect(await filesOf("goneShr")).toBe(0);
	});

	it("removes a share, and its copies, whose source conversation is gone", async () => {
		const conv = await conversation();
		const goneConv = new ObjectId();
		await (
			await shares()
		).insertMany([
			share("keepShr", { conversationId: conv._id }),
			share("dropShr", { conversationId: goneConv }),
		]);
		await storeFile("keepShr", "a", old());
		await storeFile("dropShr", "b", old());

		const counts = await sweepOrphanAttachments();

		expect(counts.shares).toBe(1);
		expect(await (await shares()).countDocuments({ _id: "dropShr" as never })).toBe(0);
		expect(await filesOf("dropShr")).toBe(0);
		expect(await (await shares()).countDocuments({ _id: "keepShr" as never })).toBe(1);
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
		await setUploadDate(await putBlob("kb.pdf", { owner: "u1" }, "kb"), old());

		const counts = await sweepOrphanAttachments();

		expect(counts.files).toBe(0);
		expect(await filesOf("some-other-tag")).toBe(1);
		expect(await collections.blobStore.count("files", { "metadata.owner": "u1" })).toBe(1);
	});
});
