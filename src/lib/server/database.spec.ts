import { beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { backfillLegacySharedConversationOwners } from "./database";
import { collections, ready } from "./database";

describe("backfillLegacySharedConversationOwners (ADR 0093 deviation)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("attributes a legacy share to the owner of the conversation it was copied from", async () => {
		const userId = new ObjectId();
		const rootMessageId = `root-${new ObjectId().toString()}`;
		await collections.conversations.insertOne({
			_id: new ObjectId(),
			userId,
			title: "t",
			rootMessageId,
			messages: [{ id: rootMessageId, from: "user", content: "hi", createdAt: new Date() }],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const shareId = `share-${new ObjectId().toString().slice(0, 8)}`;
		await collections.sharedConversations.insertOne({
			_id: shareId,
			hash: shareId,
			title: "t",
			rootMessageId,
			messages: [{ id: rootMessageId, from: "user", content: "hi", createdAt: new Date() }],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const result = await backfillLegacySharedConversationOwners(
			collections.sharedConversations,
			collections.conversations
		);
		expect(result.attributed).toBeGreaterThanOrEqual(1);

		const reloaded = await collections.sharedConversations.findOne({ _id: shareId });
		expect(reloaded?.userId?.equals(userId)).toBe(true);

		await collections.conversations.deleteMany({ userId });
		await collections.sharedConversations.deleteOne({ _id: shareId });
	});

	it("counts a share as unattributed when no conversation carries its root message", async () => {
		const shareId = `share-${new ObjectId().toString().slice(0, 8)}`;
		await collections.sharedConversations.insertOne({
			_id: shareId,
			hash: shareId,
			title: "t",
			rootMessageId: `orphan-${new ObjectId().toString()}`,
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const result = await backfillLegacySharedConversationOwners(
			collections.sharedConversations,
			collections.conversations
		);
		expect(result.unattributed).toBeGreaterThanOrEqual(1);

		const reloaded = await collections.sharedConversations.findOne({ _id: shareId });
		expect(reloaded?.userId).toBeUndefined();

		await collections.sharedConversations.deleteOne({ _id: shareId });
	});

	it("is idempotent: a share already attributed is never reconsidered", async () => {
		const userId = new ObjectId();
		const otherUserId = new ObjectId();
		const rootMessageId = `root-${new ObjectId().toString()}`;
		await collections.conversations.insertOne({
			_id: new ObjectId(),
			userId: otherUserId,
			title: "t",
			rootMessageId,
			messages: [{ id: rootMessageId, from: "user", content: "hi", createdAt: new Date() }],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const shareId = `share-${new ObjectId().toString().slice(0, 8)}`;
		await collections.sharedConversations.insertOne({
			_id: shareId,
			hash: shareId,
			title: "t",
			rootMessageId,
			userId, // already attributed, to someone other than the conversation's owner
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		await backfillLegacySharedConversationOwners(
			collections.sharedConversations,
			collections.conversations
		);

		const reloaded = await collections.sharedConversations.findOne({ _id: shareId });
		expect(reloaded?.userId?.equals(userId)).toBe(true);

		await collections.conversations.deleteMany({ userId: otherUserId });
		await collections.sharedConversations.deleteOne({ _id: shareId });
	});
});
