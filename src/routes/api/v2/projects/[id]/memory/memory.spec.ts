import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { DELETE as deleteProject } from "../+server";
import { DELETE, PATCH } from "./[noteId]/+server";
import { GET, POST } from "./+server";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
	await collections.projects.deleteMany({});
	await collections.projectMemories.deleteMany({});
});

const json = (body: unknown) => ({
	body: JSON.stringify(body),
	headers: { "content-type": "application/json" },
});

async function setup() {
	const { user: owner, locals: ownerLocals } = await createTestUser();
	const member = await createTestUser();
	const outsider = await createTestUser();
	// A share names an address; the viewer's own address is what matches it.
	const memberLocals = {
		...member.locals,
		user: { ...member.user, email: "member@example.org" },
	};
	const outsiderLocals = {
		...outsider.locals,
		user: { ...outsider.user, email: "outsider@example.org" },
	};
	const projectId = new ObjectId();
	await collections.projects.insertOne({
		_id: projectId,
		userId: owner._id,
		name: "P",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: false,
		retrievalLimit: 6,
		shares: [{ kind: "user", email: "member@example.org" }],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return { owner, ownerLocals, memberLocals, outsiderLocals, projectId };
}

const path = (projectId: ObjectId, noteId?: string) =>
	`/api/v2/projects/${projectId}/memory${noteId ? `/${noteId}` : ""}`;

describe("/api/v2/projects/[id]/memory", () => {
	it("refuses a non-member on every verb, as if the project did not exist", async () => {
		const { ownerLocals, outsiderLocals, projectId } = await setup();
		const created = await testRequest(POST, {
			path: path(projectId),
			method: "POST",
			params: { id: projectId.toString() },
			locals: ownerLocals,
			...json({ text: "Owner's note." }),
		});
		const noteId = ((await created.json()) as { data: { id: string } }).data.id;
		const params = { id: projectId.toString() };

		const read = await testRequest(GET, { path: path(projectId), params, locals: outsiderLocals });
		const write = await testRequest(POST, {
			path: path(projectId),
			method: "POST",
			params,
			locals: outsiderLocals,
			...json({ text: "Sneaky." }),
		});
		const edit = await testRequest(PATCH, {
			path: path(projectId, noteId),
			method: "PATCH",
			params: { ...params, noteId },
			locals: outsiderLocals,
			...json({ text: "Rewritten." }),
		});
		const remove = await testRequest(DELETE, {
			path: path(projectId, noteId),
			method: "DELETE",
			params: { ...params, noteId },
			locals: outsiderLocals,
		});

		expect([read.status, write.status, edit.status, remove.status]).toEqual([404, 404, 404, 404]);
		const rows = await collections.projectMemories.find({ projectId }).toArray();
		expect(rows.map((row) => row.text)).toEqual(["Owner's note."]);
	});

	it("lets the owner and a shared member add, read, edit and delete, with authors shown", async () => {
		const { ownerLocals, memberLocals, projectId } = await setup();
		const params = { id: projectId.toString() };

		const added = await testRequest(POST, {
			path: path(projectId),
			method: "POST",
			params,
			locals: memberLocals,
			...json({ text: "Member's note." }),
		});
		expect(added.status).toBe(201);
		const note = ((await added.json()) as { data: { id: string; author: string; mine: boolean } })
			.data;
		expect(note).toMatchObject({ author: "Test User", mine: true });

		const asOwner = await testRequest(GET, { path: path(projectId), params, locals: ownerLocals });
		const listed = (await asOwner.json()) as {
			data: { notes: { id: string; text: string; mine: boolean; source: string }[] };
		};
		expect(listed.data.notes).toMatchObject([
			{ id: note.id, text: "Member's note.", mine: false, source: "user" },
		]);

		const edited = await testRequest(PATCH, {
			path: path(projectId, note.id),
			method: "PATCH",
			params: { ...params, noteId: note.id },
			locals: ownerLocals,
			...json({ text: "Owner edited it." }),
		});
		expect(edited.status).toBe(200);

		const removed = await testRequest(DELETE, {
			path: path(projectId, note.id),
			method: "DELETE",
			params: { ...params, noteId: note.id },
			locals: memberLocals,
		});
		expect(removed.status).toBe(204);
		expect(await collections.projectMemories.countDocuments({ projectId })).toBe(0);
	});

	it("rejects an over-long note with 400", async () => {
		const { ownerLocals, projectId } = await setup();
		const res = await testRequest(POST, {
			path: path(projectId),
			method: "POST",
			params: { id: projectId.toString() },
			locals: ownerLocals,
			...json({ text: "x".repeat(2001) }),
		});
		expect(res.status).toBe(400);
	});

	it("deletes the notes with the project", async () => {
		const { ownerLocals, projectId } = await setup();
		await testRequest(POST, {
			path: path(projectId),
			method: "POST",
			params: { id: projectId.toString() },
			locals: ownerLocals,
			...json({ text: "Goes with the project." }),
		});
		const res = await testRequest(deleteProject, {
			path: `/api/v2/projects/${projectId}`,
			method: "DELETE",
			params: { id: projectId.toString() },
			locals: ownerLocals,
		});
		expect(res.status).toBe(204);
		expect(await collections.projectMemories.countDocuments({ projectId })).toBe(0);
	});
});
