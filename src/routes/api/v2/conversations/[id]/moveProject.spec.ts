import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const { deleteDerivedMock, indexMock } = vi.hoisted(() => ({
	deleteDerivedMock: vi.fn(),
	indexMock: vi.fn(),
}));
vi.mock("$lib/server/knowledge/deleteDerived", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/knowledge/deleteDerived")>();
	return { ...actual, deleteDerived: deleteDerivedMock };
});
vi.mock("$lib/server/projects", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/projects")>();
	return { ...actual, indexConversation: indexMock };
});

import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { PATCH } from "./+server";

beforeAll(async () => {
	await ready;
}, 30000);

beforeEach(() => {
	deleteDerivedMock.mockResolvedValue(undefined);
	indexMock.mockResolvedValue(undefined);
});

afterEach(async () => {
	deleteDerivedMock.mockReset();
	indexMock.mockReset();
	await cleanupTestData();
	await collections.projects.deleteMany({});
});

async function project(userId: ObjectId, name: string, shareEmail?: string) {
	const _id = new ObjectId();
	await collections.projects.insertOne({
		_id,
		userId,
		name,
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: true,
		retrievalLimit: 6,
		shares: shareEmail ? [{ kind: "user", email: shareEmail }] : [],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return _id;
}

async function setup() {
	const owner = await createTestUser();
	const other = await createTestUser();
	const otherLocals = { ...other.locals, user: { ...other.user, email: "other@example.org" } };
	const mine = await project(owner.user._id, "Mine");
	const mine2 = await project(owner.user._id, "Mine two");
	const theirs = await project(other.user._id, "Theirs");
	const sharedWithOwner = await project(other.user._id, "Shared", "owner@example.org");
	owner.locals = { ...owner.locals, user: { ...owner.user, email: "owner@example.org" } };
	return { owner, otherLocals, other, mine, mine2, theirs, sharedWithOwner };
}

const patch = (id: ObjectId, body: unknown, locals: Partial<App.Locals>) =>
	testRequest(PATCH, {
		path: `/api/v2/conversations/${id}`,
		method: "PATCH",
		params: { id: id.toString() },
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		locals,
	});

const stored = (id: ObjectId) => collections.conversations.findOne({ _id: id });

describe("PATCH /api/v2/conversations/[id] { projectId }", () => {
	it("moves a loose chat into a project and indexes its existing thread", async () => {
		const { owner, mine } = await setup();
		const chat = await createTestConversation(owner.locals);
		const res = await patch(chat._id, { projectId: mine.toString() }, owner.locals);
		expect(res.status).toBe(200);
		expect((await stored(chat._id))?.projectId?.toString()).toBe(mine.toString());
		expect(deleteDerivedMock).not.toHaveBeenCalled();
		expect(indexMock).toHaveBeenCalledTimes(1);
		const call = indexMock.mock.calls[0][0];
		expect(call.project._id.toString()).toBe(mine.toString());
		expect(call.conversation._id.toString()).toBe(chat._id.toString());
	});

	it("moves between projects: out of the first (memory cleanup), into the second (index)", async () => {
		const { owner, mine, mine2 } = await setup();
		const chat = await createTestConversation(owner.locals, { projectId: mine });
		const res = await patch(chat._id, { projectId: mine2.toString() }, owner.locals);
		expect(res.status).toBe(200);
		expect((await stored(chat._id))?.projectId?.toString()).toBe(mine2.toString());
		expect(deleteDerivedMock).toHaveBeenCalledWith({ conversationId: chat._id });
		expect(indexMock).toHaveBeenCalledTimes(1);
		expect(indexMock.mock.calls[0][0].project._id.toString()).toBe(mine2.toString());
	});

	it("moves out with null: clears projectId and the transcript, keeps the chat", async () => {
		const { owner, mine } = await setup();
		const chat = await createTestConversation(owner.locals, { projectId: mine });
		const res = await patch(chat._id, { projectId: null }, owner.locals);
		expect(res.status).toBe(200);
		const kept = await stored(chat._id);
		expect(kept).not.toBeNull();
		expect(kept?.projectId).toBeUndefined();
		expect(deleteDerivedMock).toHaveBeenCalledWith({ conversationId: chat._id });
		expect(indexMock).not.toHaveBeenCalled();
	});

	it("accepts a project shared with the caller, and refuses one they cannot see", async () => {
		const { owner, theirs, sharedWithOwner } = await setup();
		const chat = await createTestConversation(owner.locals);
		expect((await patch(chat._id, { projectId: theirs.toString() }, owner.locals)).status).toBe(404);
		expect((await stored(chat._id))?.projectId).toBeUndefined();
		expect(indexMock).not.toHaveBeenCalled();
		const ok = await patch(chat._id, { projectId: sharedWithOwner.toString() }, owner.locals);
		expect(ok.status).toBe(200);
	});

	it("refuses to move someone else's chat in or between projects", async () => {
		const { owner, otherLocals, mine, mine2 } = await setup();
		const loose = await createTestConversation(otherLocals);
		const inProject = await createTestConversation(otherLocals, { projectId: mine });
		expect((await patch(loose._id, { projectId: mine.toString() }, owner.locals)).status).toBe(404);
		expect(
			(await patch(inProject._id, { projectId: mine2.toString() }, owner.locals)).status
		).toBe(404);
		expect((await stored(inProject._id))?.projectId?.toString()).toBe(mine.toString());
		expect(indexMock).not.toHaveBeenCalled();
		expect(deleteDerivedMock).not.toHaveBeenCalled();
	});

	it("lets a project's owner take a member's chat out, but not anyone else", async () => {
		const { owner, otherLocals, mine } = await setup();
		const chat = await createTestConversation(otherLocals, { projectId: mine });
		const stranger = await createTestUser();
		expect((await patch(chat._id, { projectId: null }, stranger.locals)).status).toBe(404);
		expect((await stored(chat._id))?.projectId).toBeDefined();
		expect((await patch(chat._id, { projectId: null }, owner.locals)).status).toBe(200);
		expect((await stored(chat._id))?.projectId).toBeUndefined();
		expect(deleteDerivedMock).toHaveBeenCalledWith({ conversationId: chat._id });
	});

	it("rejects a malformed projectId", async () => {
		const { owner } = await setup();
		const chat = await createTestConversation(owner.locals);
		expect((await patch(chat._id, { projectId: "nope" }, owner.locals)).status).toBe(400);
	});
});
