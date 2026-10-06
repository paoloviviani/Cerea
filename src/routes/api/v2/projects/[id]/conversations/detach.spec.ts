import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const { deleteDerivedMock } = vi.hoisted(() => ({ deleteDerivedMock: vi.fn() }));
vi.mock("$lib/server/knowledge/deleteDerived", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/knowledge/deleteDerived")>();
	return { ...actual, deleteDerived: deleteDerivedMock };
});

import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { DELETE } from "./[conversationId]/+server";

beforeAll(async () => {
	await ready;
}, 30000);

beforeEach(() => deleteDerivedMock.mockResolvedValue(undefined));

afterEach(async () => {
	deleteDerivedMock.mockReset();
	await cleanupTestData();
	await collections.projects.deleteMany({});
});

async function setup() {
	const owner = await createTestUser();
	const member = await createTestUser();
	const memberLocals = { ...member.locals, user: { ...member.user, email: "member@example.org" } };
	const projectId = new ObjectId();
	await collections.projects.insertOne({
		_id: projectId,
		userId: owner.user._id,
		name: "P",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: true,
		retrievalLimit: 6,
		shares: [{ kind: "user", email: "member@example.org" }],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return { owner, memberLocals, projectId };
}

const remove = (projectId: ObjectId, conversationId: ObjectId, locals: Partial<App.Locals>) =>
	testRequest(DELETE, {
		path: `/api/v2/projects/${projectId}/conversations/${conversationId}`,
		method: "DELETE",
		params: { id: projectId.toString(), conversationId: conversationId.toString() },
		locals,
	});

describe("DELETE /api/v2/projects/[id]/conversations/[conversationId]", () => {
	it("clears projectId and the project-memory transcript, and keeps the conversation", async () => {
		const { owner, projectId } = await setup();
		const chat = await createTestConversation(owner.locals, { projectId });
		const res = await remove(projectId, chat._id, owner.locals);
		expect(res.status).toBe(204);
		const kept = await collections.conversations.findOne({ _id: chat._id });
		expect(kept).not.toBeNull();
		expect(kept?.projectId).toBeUndefined();
		expect(deleteDerivedMock).toHaveBeenCalledWith({ conversationId: chat._id });
	});

	it("lets the project's owner remove a member's chat, but not one member another's", async () => {
		const { owner, memberLocals, projectId } = await setup();
		const members = await createTestConversation(memberLocals, { projectId });
		const ownersChat = await createTestConversation(owner.locals, { projectId });

		expect((await remove(projectId, ownersChat._id, memberLocals)).status).toBe(403);
		expect((await remove(projectId, members._id, memberLocals)).status).toBe(204);
		expect((await remove(projectId, ownersChat._id, owner.locals)).status).toBe(204);
	});

	it("404s a chat that is not in this project, and a stranger", async () => {
		const { owner, projectId } = await setup();
		const loose = await createTestConversation(owner.locals);
		expect((await remove(projectId, loose._id, owner.locals)).status).toBe(404);
		const stranger = await createTestUser();
		const inside = await createTestConversation(owner.locals, { projectId });
		expect((await remove(projectId, inside._id, stranger.locals)).status).toBe(404);
		expect((await collections.conversations.findOne({ _id: inside._id }))?.projectId).toEqual(
			projectId
		);
	});
});
