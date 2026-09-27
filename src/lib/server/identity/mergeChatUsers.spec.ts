import { beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { mergeChatUsers } from "./mergeChatUsers";
import { USER_KEYED_COLLECTIONS } from "./userKeyedCollections";

async function insertUser() {
	const doc = {
		_id: new ObjectId(),
		createdAt: new Date(),
		updatedAt: new Date(),
		name: "somebody",
		hfUserId: new ObjectId().toString(),
	};
	await collections.users.insertOne(doc as never);
	return doc._id;
}

describe("mergeChatUsers (ADR 0093 §7.2)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("touches every registered collection, keeps the target's data, and deletes the stray", async () => {
		const stray = await insertUser();
		const target = await insertUser();

		// One document the stray owns in each "reassigned" collection...
		const strayConv = new ObjectId();
		await collections.conversations.insertOne({
			_id: strayConv,
			userId: stray,
			title: "stray's chat",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const strayProject = new ObjectId();
		await collections.projects.insertOne({
			_id: strayProject,
			userId: stray,
			name: "stray's project",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const strayStore = new ObjectId();
		await collections.vectorStores.insertOne({
			_id: strayStore,
			name: "stray's base",
			ownerId: stray,
			embeddingModel: "m",
			dimensions: null,
			chunkChars: 100,
			chunkOverlap: 0,
			shares: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const strayDoc = new ObjectId();
		await collections.knowledgeDocuments.insertOne({
			_id: strayDoc,
			storeId: strayStore,
			title: "a passage",
			chars: 1,
			chunkCount: 1,
			status: "ready",
			error: "",
			embeddingModel: null,
			indexedAt: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const strayDevice = new ObjectId();
		await collections.codeDevices.insertOne({
			_id: strayDevice,
			userId: stray,
			machineId: "machine-stray",
			name: "stray's laptop",
			status: "paired",
			sub: "sub",
			iss: "iss",
			backends: [],
			policy: {},
			credentialState: "ok",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		// ...a knowledge blob tagged by the stray's own id directly...
		const blobUpload = collections.bucket.openUploadStream(`blob-${stray.toString()}`, {
			metadata: { mime: "text/plain", owner: stray.toString() },
		});
		blobUpload.end(Buffer.from("hello"));
		await new Promise((resolve, reject) => {
			blobUpload.on("finish", resolve);
			blobUpload.on("error", reject);
		});

		// ...a settings row and a session, which have their own rules...
		await collections.settings.insertOne({
			userId: stray,
			shareConversationsWithModelAuthors: false,
			streamingMode: "raw",
			directPaste: true,
			hapticsEnabled: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		await collections.settings.insertOne({
			userId: target,
			shareConversationsWithModelAuthors: true,
			streamingMode: "smooth",
			directPaste: false,
			hapticsEnabled: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		await collections.sessions.insertOne({
			_id: new ObjectId(),
			sessionId: "stray-session",
			userId: stray,
			createdAt: new Date(),
			updatedAt: new Date(),
			expiresAt: new Date(Date.now() + 1000 * 60 * 60),
		} as never);

		// ...and the target already owns a conversation of its own, which a
		// merge must never touch ("merge is not erasure").
		const targetConv = new ObjectId();
		await collections.conversations.insertOne({
			_id: targetConv,
			userId: target,
			title: "target's own chat",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const result = await mergeChatUsers(stray, target);

		// Every registry entry ran, by construction.
		expect(Object.keys(result.counts).sort()).toEqual(
			USER_KEYED_COLLECTIONS.map((e) => e.name).sort()
		);

		expect(
			(await collections.conversations.findOne({ _id: strayConv }))?.userId?.equals(target)
		).toBe(true);
		expect(
			(await collections.projects.findOne({ _id: strayProject }))?.userId?.equals(target)
		).toBe(true);
		expect(
			(await collections.vectorStores.findOne({ _id: strayStore }))?.ownerId.equals(target)
		).toBe(true);
		// knowledgeDocuments carries no owner field: it follows its store.
		expect(await collections.knowledgeDocuments.findOne({ _id: strayDoc })).not.toBeNull();
		expect(
			(await collections.codeDevices.findOne({ _id: strayDevice }))?.userId?.equals(target)
		).toBe(true);

		const blobs = await collections.bucketFiles
			.find({ "metadata.owner": { $in: [stray.toString(), target.toString()] } })
			.toArray();
		expect(blobs).toHaveLength(1);
		expect(blobs[0].metadata?.owner).toBe(target.toString());

		// settings: the target's own row survives untouched, the stray's is gone.
		const targetSettings = await collections.settings.findOne({ userId: target });
		expect(targetSettings?.streamingMode).toBe("smooth");
		expect(await collections.settings.findOne({ userId: stray })).toBeNull();

		// sessions: the stray's is deleted outright, no reassignment.
		expect(await collections.sessions.findOne({ sessionId: "stray-session" })).toBeNull();

		// the target's pre-existing conversation is untouched.
		const untouchedTargetConv = await collections.conversations.findOne({ _id: targetConv });
		expect(untouchedTargetConv?.title).toBe("target's own chat");

		// the stray account itself is gone.
		expect(await collections.users.findOne({ _id: stray })).toBeNull();

		await collections.conversations.deleteMany({ _id: { $in: [strayConv, targetConv] } });
		await collections.projects.deleteOne({ _id: strayProject });
		await collections.vectorStores.deleteOne({ _id: strayStore });
		await collections.knowledgeDocuments.deleteOne({ _id: strayDoc });
		await collections.codeDevices.deleteOne({ _id: strayDevice });
		await collections.bucketFiles.deleteMany({ "metadata.owner": target.toString() });
		for (const file of blobs) await collections.bucket.delete(file._id).catch(() => undefined);
		await collections.settings.deleteMany({ userId: { $in: [stray, target] } });
		await collections.users.deleteOne({ _id: target });
	});

	it("is idempotent: calling it again for an already-merged (now deleted) stray does nothing", async () => {
		const stray = await insertUser();
		const target = await insertUser();

		const first = await mergeChatUsers(stray, target);
		expect(await collections.users.findOne({ _id: stray })).toBeNull();

		const second = await mergeChatUsers(stray, target);
		for (const name of Object.keys(second.counts)) {
			expect(second.counts[name]).toBe(0);
		}
		void first;

		await collections.users.deleteOne({ _id: target });
	});

	it("refuses to merge an account into itself", async () => {
		const user = await insertUser();
		await expect(mergeChatUsers(user, user)).rejects.toThrow();
		await collections.users.deleteOne({ _id: user });
	});
});
