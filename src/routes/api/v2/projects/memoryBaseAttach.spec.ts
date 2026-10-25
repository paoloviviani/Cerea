import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { PATCH } from "./[id]/+server";
import { GET } from "./[id]/+server";
import { POST } from "./+server";

const MEMORY = "a1a1a1a1a1a1a1a1a1a1a1a1";
const ORDINARY = "b2b2b2b2b2b2b2b2b2b2b2b2";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
	await collections.projects.deleteMany({});
});

async function makeProject(userId: ObjectId, extra: Record<string, unknown> = {}) {
	const _id = new ObjectId();
	await collections.projects.insertOne({
		_id,
		userId,
		name: "P",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: true,
		shares: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...extra,
	} as never);
	return _id;
}

const patch = (id: ObjectId, locals: App.Locals, body: unknown) =>
	testRequest(PATCH, {
		path: `/api/v2/projects/${id}`,
		method: "PATCH",
		params: { id: id.toString() },
		locals,
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});

describe("a project's chat memory is not an attachable knowledge base", () => {
	it("refuses it on update, its own project's or another's, and accepts an ordinary base", async () => {
		const { user, locals } = await createTestUser();
		const id = await makeProject(user._id, { memoryBaseId: MEMORY });
		await makeProject(user._id, { memoryBaseId: "c3c3c3c3c3c3c3c3c3c3c3c3" });

		for (const bad of [MEMORY, "c3c3c3c3c3c3c3c3c3c3c3c3"]) {
			const res = await patch(id, locals, { knowledgeBaseIds: [ORDINARY, bad] });
			expect(res.status).toBe(400);
			expect(await res.text()).toContain("chat memory");
		}
		expect((await collections.projects.findOne({ _id: id }))?.knowledgeBaseIds).toEqual([]);

		const ok = await patch(id, locals, { knowledgeBaseIds: [ORDINARY] });
		expect(ok.status).toBe(200);
		expect((await collections.projects.findOne({ _id: id }))?.knowledgeBaseIds).toEqual([ORDINARY]);
	});

	it("refuses it on create", async () => {
		const { user, locals } = await createTestUser();
		await makeProject(user._id, { memoryBaseId: MEMORY });
		const res = await testRequest(POST, {
			path: "/api/v2/projects",
			method: "POST",
			locals,
			body: JSON.stringify({ name: "New", knowledgeBaseIds: [MEMORY] }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(400);
	});

	it("does not report one already stored in a project's attached list", async () => {
		const { user, locals } = await createTestUser();
		const id = await makeProject(user._id, {
			memoryBaseId: MEMORY,
			knowledgeBaseIds: [MEMORY, ORDINARY],
		});
		const res = await testRequest(GET, {
			path: `/api/v2/projects/${id}`,
			params: { id: id.toString() },
			locals,
		});
		expect((await res.json()).knowledgeBaseIds).toEqual([ORDINARY]);
	});
});
