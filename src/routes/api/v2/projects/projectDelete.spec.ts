import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { DELETE } from "./[id]/+server";
import { putBlob } from "$lib/server/blobs/testing";

// The knowledge store is Postgres, which these specs do not start: record what
// would be removed from it instead (the rows in Mongo and the blobs are real).
const deleteDerived = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("$lib/server/knowledge/deleteDerived", () => ({ deleteDerived }));

beforeEach(() => deleteDerived.mockClear());

const droppedStores = () =>
	(deleteDerived.mock.calls as unknown as [{ storeIds?: ObjectId; dropStores?: boolean }][])
		.filter(([arg]) => arg.dropStores)
		.map(([arg]) => String(arg.storeIds));
const transcriptsCleared = () =>
	(deleteDerived.mock.calls as unknown as [{ conversationId?: ObjectId }][])
		.filter(([arg]) => arg.conversationId)
		.flatMap(([arg]) => [arg.conversationId].flat().map(String));

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
	await collections.projects.deleteMany({});
	await collections.vectorStores.deleteMany({});
	await collections.projectMemories.deleteMany({});
});

async function seed(options: { memoryOwner?: "owner" | "member"; keepChatsQuery?: string } = {}) {
	const owner = await createTestUser();
	const member = await createTestUser();
	const projectId = new ObjectId();
	const memoryBaseId = new ObjectId();
	const attachedId = new ObjectId();
	for (const [id, ownerId] of [
		[memoryBaseId, options.memoryOwner === "member" ? member.user._id : owner.user._id],
		[attachedId, owner.user._id],
	] as const) {
		await collections.vectorStores.insertOne({
			_id: id,
			name: "kb",
			ownerId,
			embeddingModel: "e",
			dimensions: null,
			chunkChars: 100,
			chunkOverlap: 0,
			shares: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
	}
	await collections.projects.insertOne({
		_id: projectId,
		userId: owner.user._id,
		name: "P",
		instructions: "",
		knowledgeBaseIds: [attachedId.toString()],
		memoryBaseId: memoryBaseId.toString(),
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	await collections.projectMemories.insertOne({
		_id: new ObjectId(),
		projectId,
		userId: owner.user._id,
		text: "note",
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	const mine = await createTestConversation(owner.locals, { projectId });
	const theirs = await createTestConversation(member.locals, { projectId });
	const loose = await createTestConversation(owner.locals);
	for (const c of [mine, theirs, loose]) {
		await putBlob(`${c._id}-x`, { conversation: c._id.toString() }, "b");
	}
	return { owner, projectId, memoryBaseId, attachedId, mine, theirs, loose };
}

async function del(owner: { locals: App.Locals }, projectId: ObjectId, query = "") {
	return testRequest(DELETE, {
		path: `/api/v2/projects/${projectId}${query}`,
		method: "DELETE",
		params: { id: projectId.toString() },
		locals: owner.locals,
	});
}

const blobs = (ids: ObjectId[]) =>
	collections.blobStore.count("files", {
		"metadata.conversation": { $in: ids.map(String) },
	});

describe("DELETE /api/v2/projects/[id]", () => {
	it("deletes the owner's chats with their storage, detaches a member's chat, keeps loose chats", async () => {
		const t = await seed();
		const res = await del(t.owner, t.projectId);

		expect(res.status).toBe(204);
		expect(await collections.projects.countDocuments({ _id: t.projectId })).toBe(0);
		expect(await collections.conversations.countDocuments({ _id: t.mine._id })).toBe(0);
		expect(await blobs([t.mine._id])).toBe(0);
		const theirs = await collections.conversations.findOne({ _id: t.theirs._id });
		expect(theirs).not.toBeNull();
		expect(theirs?.projectId).toBeUndefined();
		expect(await blobs([t.theirs._id, t.loose._id])).toBe(2);
		expect(await collections.conversations.countDocuments({ _id: t.loose._id })).toBe(1);
		// Storage cleanup ran for the deleted chat and the detach for the member's.
		expect(transcriptsCleared()).toEqual(
			expect.arrayContaining([String(t.mine._id), String(t.theirs._id)])
		);
		expect(transcriptsCleared()).not.toContain(String(t.loose._id));
	});

	it("keepChats=1 detaches every chat and deletes nothing of theirs", async () => {
		const t = await seed();
		const res = await del(t.owner, t.projectId, "?keepChats=1");

		expect(res.status).toBe(204);
		for (const c of [t.mine, t.theirs]) {
			const row = await collections.conversations.findOne({ _id: c._id });
			expect(row).not.toBeNull();
			expect(row?.projectId).toBeUndefined();
		}
		expect(await blobs([t.mine._id, t.theirs._id])).toBe(2);
		// The memory base goes either way.
		expect(droppedStores()).toEqual([String(t.memoryBaseId)]);
	});

	it("always drops the memory base the owner owns, with notes; keeps attached bases", async () => {
		const t = await seed();
		await del(t.owner, t.projectId, "?memory=delete");
		expect(droppedStores()).toEqual([String(t.memoryBaseId)]);
		expect(await collections.vectorStores.countDocuments({ _id: t.attachedId })).toBe(1);
		expect(await collections.projectMemories.countDocuments({ projectId: t.projectId })).toBe(0);

		const u = await seed();
		await del(u.owner, u.projectId);
		expect(droppedStores()).toContain(String(u.memoryBaseId));
		expect(droppedStores()).not.toContain(String(u.attachedId));
	});

	it("leaves a memory base somebody else owns", async () => {
		const t = await seed({ memoryOwner: "member" });
		await del(t.owner, t.projectId);
		expect(droppedStores()).toEqual([]);
		expect(await collections.vectorStores.countDocuments({ _id: t.memoryBaseId })).toBe(1);
		expect(await collections.projects.countDocuments({ _id: t.projectId })).toBe(0);
	});
});
