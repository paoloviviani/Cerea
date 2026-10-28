import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import superjson from "superjson";

import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { GET } from "./+server";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
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

async function get(id: ObjectId, locals: Partial<App.Locals>) {
	const res = await testRequest(GET, {
		path: `/api/v2/conversations/${id}`,
		params: { id: id.toString() },
		locals,
	});
	expect(res.status).toBe(200);
	return superjson.parse<{ projectId?: string; projectName?: string }>(await res.text());
}

describe("GET /api/v2/conversations/[id] projectName", () => {
	it("names the project of a project chat", async () => {
		const owner = await createTestUser();
		const p = await project(owner.user._id, "Padova 1 Novembre 2026");
		const chat = await createTestConversation(owner.locals, { projectId: p });
		const body = await get(chat._id, owner.locals);
		expect(body.projectId).toBe(p.toString());
		expect(body.projectName).toBe("Padova 1 Novembre 2026");
	});

	it("names nothing for a chat outside a project", async () => {
		const owner = await createTestUser();
		const chat = await createTestConversation(owner.locals);
		expect((await get(chat._id, owner.locals)).projectName).toBeUndefined();
	});

	it("names nothing when the project is gone", async () => {
		const owner = await createTestUser();
		const chat = await createTestConversation(owner.locals, { projectId: new ObjectId() });
		expect((await get(chat._id, owner.locals)).projectName).toBeUndefined();
	});

	it("names nothing when the project is no longer shared with the chat's owner", async () => {
		const owner = await createTestUser();
		const other = await createTestUser();
		const p = await project(other.user._id, "Not yours any more");
		const chat = await createTestConversation(owner.locals, { projectId: p });
		expect((await get(chat._id, owner.locals)).projectName).toBeUndefined();
	});
});
