/**
 * A chat's own notes over HTTP: access is the conversation's own, an id from another chat is a
 * 404, and deleting the chat deletes its notes.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { deleteConversationStorage } from "$lib/server/conversationStorage";
import { buildConversationMemoryBlock } from "$lib/server/memory/service";
import { DELETE, PATCH } from "./[noteId]/+server";
import { GET, POST } from "./+server";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
	await collections.conversationMemories.deleteMany({});
});

const json = (body: unknown) => ({
	body: JSON.stringify(body),
	headers: { "content-type": "application/json" },
});

async function setup() {
	const me = await createTestUser();
	const other = await createTestUser();
	const conv = await createTestConversation(me.locals);
	const otherConv = await createTestConversation(me.locals);
	return { me, other, conv, otherConv };
}

const add = (locals: App.Locals, id: ObjectId, text: string) =>
	testRequest(POST, {
		path: `/api/v2/conversations/${id}/memory`,
		method: "POST",
		params: { id: id.toString() },
		locals,
		...json({ text }),
	});

describe("/api/v2/conversations/[id]/memory", () => {
	it("lists, adds, edits and deletes the chat's notes", async () => {
		const { me, conv } = await setup();
		const created = await add(me.locals, conv._id, "Keep answers short.");
		expect(created.status).toBe(201);
		const note = (await created.json()).data;
		expect(note.source).toBe("user");
		const listed = await testRequest(GET, {
			path: `/api/v2/conversations/${conv._id}/memory`,
			params: { id: conv._id.toString() },
			locals: me.locals,
		});
		expect((await listed.json()).data.notes).toHaveLength(1);

		const patched = await testRequest(PATCH, {
			path: `/api/v2/conversations/${conv._id}/memory/${note.id}`,
			method: "PATCH",
			params: { id: conv._id.toString(), noteId: note.id },
			locals: me.locals,
			...json({ text: "Keep answers very short." }),
		});
		expect((await patched.json()).data.text).toBe("Keep answers very short.");
		const gone = await testRequest(DELETE, {
			path: `/api/v2/conversations/${conv._id}/memory/${note.id}`,
			method: "DELETE",
			params: { id: conv._id.toString(), noteId: note.id },
			locals: me.locals,
		});
		expect(gone.status).toBe(204);
		expect(await collections.conversationMemories.countDocuments({})).toBe(0);
	});

	it("follows the conversation's own access: someone else's chat is closed to them", async () => {
		const { me, other, conv } = await setup();
		const { memory } = await (async () => {
			const created = await add(me.locals, conv._id, "Mine.");
			return { memory: (await created.json()).data };
		})();
		expect((await add(other.locals, conv._id, "Intruder.")).status).toBe(403);
		const read = await testRequest(GET, {
			path: `/api/v2/conversations/${conv._id}/memory`,
			params: { id: conv._id.toString() },
			locals: other.locals,
		});
		expect(read.status).toBe(403);
		const del = await testRequest(DELETE, {
			path: "x",
			method: "DELETE",
			params: { id: conv._id.toString(), noteId: memory.id },
			locals: other.locals,
		});
		expect(del.status).toBe(403);
		expect(await collections.conversationMemories.countDocuments({})).toBe(1);
	});

	it("matches a note id with its own chat only", async () => {
		const { me, conv, otherConv } = await setup();
		const created = await add(me.locals, conv._id, "In chat one.");
		const note = (await created.json()).data;
		const res = await testRequest(DELETE, {
			path: "x",
			method: "DELETE",
			params: { id: otherConv._id.toString(), noteId: note.id },
			locals: me.locals,
		});
		expect(res.status).toBe(404);
		expect(await collections.conversationMemories.countDocuments({})).toBe(1);
	});

	it("deleting the chat deletes its notes, and only its notes", async () => {
		const { me, conv, otherConv } = await setup();
		await add(me.locals, conv._id, "Goes with the chat.");
		await add(me.locals, otherConv._id, "Stays.");
		await deleteConversationStorage(conv._id);
		expect(await buildConversationMemoryBlock(conv._id)).toBeUndefined();
		expect(await buildConversationMemoryBlock(otherConv._id)).toContain("Stays.");
	});

	it("caps the size of a note and the number of notes", async () => {
		const { me, conv } = await setup();
		expect((await add(me.locals, conv._id, "x".repeat(1001))).status).toBe(400);
		for (let i = 0; i < 50; i++) await add(me.locals, conv._id, `Note ${i}`);
		expect((await add(me.locals, conv._id, "Too many")).status).toBe(400);
	});
});
