import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

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
		indexPastChats: false,
		retrievalLimit: 6,
		shares: [{ kind: "user", email: "member@example.org" }],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	const ownersChat = await createTestConversation(owner.locals, {
		projectId,
		title: "Owner secret plan",
	});
	const membersChat = await createTestConversation(memberLocals, {
		projectId,
		title: "Member salary talk",
	});
	return { owner, memberLocals, projectId, ownersChat, membersChat };
}

const list = (projectId: ObjectId, locals: Partial<App.Locals>) =>
	testRequest(GET, {
		path: `/api/v2/projects/${projectId}/conversations`,
		params: { id: projectId.toString() },
		locals,
	});

describe("GET /api/v2/projects/[id]/conversations", () => {
	it("lists the owner's own chats and counts the members'", async () => {
		const { owner, projectId, ownersChat } = await setup();
		const body = await (await list(projectId, owner.locals)).json();
		expect(body.data.map((c: { id: string }) => c.id)).toEqual([ownersChat._id.toString()]);
		expect(body.othersCount).toBe(1);
	});

	it("lists a member's own chats and counts the others', never their titles or ids", async () => {
		const { memberLocals, projectId, membersChat, ownersChat } = await setup();
		const res = await list(projectId, memberLocals);
		expect(res.status).toBe(200);
		const text = JSON.stringify(await res.clone().json());
		const body = await res.json();
		expect(body.data.map((c: { id: string }) => c.id)).toEqual([membersChat._id.toString()]);
		expect(body.othersCount).toBe(1);
		expect(text).not.toContain("Owner secret plan");
		expect(text).not.toContain(ownersChat._id.toString());
	});

	it("is 404 for somebody the project is not shared with", async () => {
		const { projectId } = await setup();
		const stranger = await createTestUser();
		expect((await list(projectId, stranger.locals)).status).toBe(404);
	});
});
