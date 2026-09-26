import { beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { EXEMPT_FROM_REGISTRY, USER_KEYED_COLLECTIONS } from "./userKeyedCollections";

/**
 * Every collection `database.ts` declares, by name, with whether it carries
 * an owner-shaped field — kept here rather than derived by reflection,
 * since nothing at runtime can read a TypeScript interface back. Adding a
 * collection (or giving one an owner field) means updating this roster by
 * hand; the point of the two tests below is that doing so is the *only*
 * way to keep them green, so a forgotten collection fails loudly here
 * rather than silently missing a merge or an erasure.
 */
const ALL_COLLECTIONS: Record<string, boolean> = {
	conversations: true,
	projects: true,
	skills: true,
	memories: true,
	vectorStores: true,
	knowledgeDocuments: true, // indirect: via storeId -> vectorStores.ownerId
	knowledgeConfig: false,
	knowledgeConfigHistory: false,
	mcpConnectors: true,
	mcpTokens: true,
	mcpOauthPending: true, // exempt: see EXEMPT_FROM_REGISTRY
	codeDevices: true,
	codeAudit: true,
	conversationStats: false,
	assistants: true,
	reports: true,
	sharedConversations: true, // ADR 0093 deviation: userId added, see SharedConversation.ts
	abortedGenerations: false,
	generations: true, // exempt: see EXEMPT_FROM_REGISTRY
	generationEvents: false,
	turnStates: true, // exempt: see EXEMPT_FROM_REGISTRY
	mcpElicitations: true, // exempt: see EXEMPT_FROM_REGISTRY
	parkedCalls: true, // exempt: see EXEMPT_FROM_REGISTRY
	nestedAgentCalls: false, // conversationId/messageId-scoped, no owner field
	settings: true,
	users: false, // the account itself, not user-keyed content
	sessions: true,
	messageEvents: true, // exempt: see EXEMPT_FROM_REGISTRY
	bucketFiles: false, // covered by the bucket: entries above
	codeExecutionOutputs: true,
	migrationResults: false,
	semaphores: false,
	tools: false,
	config: false,
};

describe("USER_KEYED_COLLECTIONS guard", () => {
	beforeAll(async () => {
		await ready;
	});

	it("has no name known to database.ts left unaccounted for", () => {
		const runtimeNames = Object.keys(collections).filter(
			(name) => name !== "bucket" && name !== "codeOutputBucket"
		);
		const missing = runtimeNames.filter((name) => !(name in ALL_COLLECTIONS));
		expect(missing, "a collection in database.ts has no roster entry here").toEqual([]);
	});

	it("registers or exempts every collection that carries an owner field", () => {
		const registered = new Set(USER_KEYED_COLLECTIONS.map((e) => e.name));
		const exempt = new Set(Object.keys(EXEMPT_FROM_REGISTRY));
		const overlap = [...registered].filter((name) => exempt.has(name));
		expect(overlap, "a collection is both registered and exempt").toEqual([]);

		const forgotten = Object.entries(ALL_COLLECTIONS)
			.filter(([, hasOwner]) => hasOwner)
			.map(([name]) => name)
			.filter((name) => !registered.has(name) && !exempt.has(name));
		expect(forgotten, "an owner-keyed collection has no registry entry and no exemption").toEqual(
			[]
		);
	});

	it("never registers a name it doesn't also exempt-check against a real reason", () => {
		for (const reason of Object.values(EXEMPT_FROM_REGISTRY)) {
			expect(reason.length).toBeGreaterThan(0);
		}
	});
});

describe("reassignWithUniqueConflict (via the mcpTokens entry)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("keeps the target's row and drops the stray's on a unique-index collision", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		const connectorId = new ObjectId();
		await collections.mcpConnectors.deleteMany({ _id: connectorId });
		await collections.mcpTokens.deleteMany({ connectorId });
		await collections.mcpTokens.insertMany([
			{
				_id: new ObjectId(),
				connectorId,
				userId: stray,
				accessTokenSealed: "stray-token",
			} as never,
			{
				_id: new ObjectId(),
				connectorId,
				userId: target,
				accessTokenSealed: "target-token",
			} as never,
		]);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "mcpTokens");
		if (!entry) throw new Error("mcpTokens must be registered");
		const moved = await entry.merge(stray, target);
		expect(moved).toBe(0);

		const remaining = await collections.mcpTokens.find({ connectorId }).toArray();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].userId.equals(target)).toBe(true);
		expect((remaining[0] as unknown as { accessTokenSealed: string }).accessTokenSealed).toBe(
			"target-token"
		);

		await collections.mcpTokens.deleteMany({ connectorId });
	});

	it("moves the stray's row when there is no collision", async () => {
		const stray = new ObjectId();
		const target = new ObjectId();
		const connectorId = new ObjectId();
		await collections.mcpTokens.insertOne({
			_id: new ObjectId(),
			connectorId,
			userId: stray,
			accessTokenSealed: "stray-token",
		} as never);

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "mcpTokens");
		if (!entry) throw new Error("mcpTokens must be registered");
		const moved = await entry.merge(stray, target);
		expect(moved).toBe(1);

		const row = await collections.mcpTokens.findOne({ connectorId });
		expect(row?.userId.equals(target)).toBe(true);

		await collections.mcpTokens.deleteMany({ connectorId });
	});
});

describe("the conversationFiles bucket entry", () => {
	beforeAll(async () => {
		await ready;
	});

	// A GridFS write plus two deletes have room to run long under this box's
	// contention (see CLAUDE.md's own flaky-test note on `replayRoundTrip`);
	// a longer budget here rather than a flaky report.
	it("erases a conversation's attachments and a shared copy's, by owner", async () => {
		const userId = new ObjectId();
		const conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId,
			title: "t",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const sharedId = `shared-${new ObjectId().toString().slice(0, 8)}`;
		await collections.sharedConversations.insertOne({
			_id: sharedId,
			userId,
			hash: sharedId,
			title: "t",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const own = collections.bucket.openUploadStream(`${conversationId}-file`, {
			metadata: { conversation: conversationId.toString() },
		});
		own.end(Buffer.from("hello"));
		const shared = collections.bucket.openUploadStream(`${sharedId}-file`, {
			metadata: { conversation: sharedId },
		});
		shared.end(Buffer.from("hello"));
		await new Promise((resolve, reject) => {
			own.on("finish", resolve);
			own.on("error", reject);
		});
		await new Promise((resolve, reject) => {
			shared.on("finish", resolve);
			shared.on("error", reject);
		});

		const entry = USER_KEYED_COLLECTIONS.find((e) => e.name === "bucket:conversationFiles");
		if (!entry) throw new Error("bucket:conversationFiles must be registered");
		const erased = await entry.erase(userId);
		expect(erased).toBe(2);

		const remaining = await collections.bucketFiles
			.find({ "metadata.conversation": { $in: [conversationId.toString(), sharedId] } })
			.toArray();
		expect(remaining).toHaveLength(0);

		await collections.conversations.deleteOne({ _id: conversationId });
		await collections.sharedConversations.deleteOne({ _id: sharedId });
	}, 60_000);
});
