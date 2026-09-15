/**
 * Attaching knowledge bases to a single conversation.
 *
 * The server is the last line the picker's mistakes reach, so each endpoint
 * that accepts ids gets the same three rejections: a malformed id, more than
 * the cap, and a base the sender cannot read. The fourth thing asserted here
 * is the quiet one — that conversations which never named a base are stored
 * without the field at all, because "no bases" and "bases: absent" must mean
 * the same thing to every reader of the collection.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import superjson from "superjson";

import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestLocals,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { POST as createConversation } from "../../../routes/conversation/+server";
import { PATCH as patchConversation } from "../../../routes/conversation/[id]/+server";
import {
	PATCH as patchConversationV2,
	GET as getConversationV2,
} from "../../../routes/api/v2/conversations/[id]/+server";
import type { VectorStore } from "$lib/types/VectorStore";

const MODEL_ID = "test-org/test-model";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
	await Promise.all([collections.vectorStores.deleteMany({}), collections.projects.deleteMany({})]);
});

const OWNED_BASE_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const FOREIGN_BASE_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";

async function makeBase(owner: ObjectId, id: string, name = "A base"): Promise<void> {
	const now = new Date();
	const base: VectorStore = {
		_id: new ObjectId(id),
		name,
		ownerId: owner,
		embeddingModel: "test-embedder",
		dimensions: null,
		chunkChars: 1000,
		chunkOverlap: 100,
		shares: [],
		createdAt: now,
		updatedAt: now,
	};
	await collections.vectorStores.insertOne(base);
}

async function createChat(locals: App.Locals, body: Record<string, unknown>) {
	const response = await createConversation({
		locals,
		request: new Request("http://localhost/conversation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as never);
	return response;
}

async function readSeed(response: Response) {
	const { conversationId, conversation } = (await response.json()) as {
		conversationId: string;
		conversation: string;
	};
	const seed = superjson.parse<{ knowledgeBases?: { id: string; name: string }[] }>(conversation);
	return { conversationId, seed };
}

describe("attaching knowledge bases at conversation create", () => {
	it("stores an owned base and hands its name to the seed", async () => {
		const { user, locals } = await createTestUser();
		await makeBase(user._id, OWNED_BASE_ID, "Specs");

		const response = await createChat(locals, {
			model: MODEL_ID,
			knowledgeBaseIds: [OWNED_BASE_ID],
		});
		expect(response.status).toBe(200);

		const { conversationId, seed } = await readSeed(response);
		const conv = await collections.conversations.findOne({
			_id: new ObjectId(conversationId),
		});
		expect(conv?.knowledgeBaseIds).toEqual([OWNED_BASE_ID]);
		expect(seed.knowledgeBases).toEqual([{ id: OWNED_BASE_ID, name: "Specs" }]);
	});

	it("refuses a base the sender cannot read", async () => {
		const { user: owner } = await createTestUser();
		const { user: sender, locals: senderLocals } = await createTestUser();
		await makeBase(owner._id, FOREIGN_BASE_ID);

		const response = createChat(senderLocals, {
			model: MODEL_ID,
			knowledgeBaseIds: [FOREIGN_BASE_ID],
		});
		await expect(response).rejects.toMatchObject({ status: 400 });
	});

	it("refuses an id that is not one of this chat's store ids", async () => {
		const { user, locals } = await createTestUser();
		const response = createChat(locals, {
			model: MODEL_ID,
			knowledgeBaseIds: ["not-a-store-id"],
		});
		await expect(response).rejects.toMatchObject({ status: 400 });
	});

	it("refuses more than twenty ids", async () => {
		const { user, locals } = await createTestUser();
		const ids = Array.from({ length: 21 }, (_, i) => i.toString(16).padStart(24, "0"));
		const response = createChat(locals, { model: MODEL_ID, knowledgeBaseIds: ids });
		await expect(response).rejects.toMatchObject({ status: 400 });
	});

	it("refuses an anonymous session that names bases", async () => {
		const response = createChat(createTestLocals(), {
			model: MODEL_ID,
			knowledgeBaseIds: [OWNED_BASE_ID],
		});
		await expect(response).rejects.toMatchObject({ status: 401 });
	});

	it("stores no field at all when none were attached", async () => {
		const { locals } = await createTestUser();

		const { conversationId } = await readSeed(
			await createChat(locals, { model: MODEL_ID })
		);
		const conv = await collections.conversations.findOne({
			_id: new ObjectId(conversationId),
		});
		expect(conv?.knowledgeBaseIds).toBeUndefined();
	});
});

describe("attaching and detaching through PATCH", () => {
	it("replaces the list wholesale, including clearing with an empty array", async () => {
		const { user, locals } = await createTestUser();
		await makeBase(user._id, OWNED_BASE_ID, "Specs");
		await makeBase(user._id, FOREIGN_BASE_ID, "More");
		const conv = await createTestConversation(locals);

		const attach = await patchConversation({
			locals,
			params: { id: conv._id.toString() },
			request: new Request("http://localhost/conversation/x", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ knowledgeBaseIds: [OWNED_BASE_ID, FOREIGN_BASE_ID] }),
			}),
		} as never);
		expect(attach.status).toBe(200);
		expect(
			(await collections.conversations.findOne({ _id: conv._id }))?.knowledgeBaseIds
		).toEqual([OWNED_BASE_ID, FOREIGN_BASE_ID]);

		const detach = await patchConversation({
			locals,
			params: { id: conv._id.toString() },
			request: new Request("http://localhost/conversation/x", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ knowledgeBaseIds: [] }),
			}),
		} as never);
		expect(detach.status).toBe(200);
		expect(
			(await collections.conversations.findOne({ _id: conv._id }))?.knowledgeBaseIds
		).toEqual([]);
	});

	it("does not touch bases when the field is absent", async () => {
		const { user, locals } = await createTestUser();
		await makeBase(user._id, OWNED_BASE_ID);
		const conv = await createTestConversation(locals, { knowledgeBaseIds: [OWNED_BASE_ID] });

		await patchConversation({
			locals,
			params: { id: conv._id.toString() },
			request: new Request("http://localhost/conversation/x", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Renamed" }),
			}),
		} as never);

		expect(
			(await collections.conversations.findOne({ _id: conv._id }))?.knowledgeBaseIds
		).toEqual([OWNED_BASE_ID]);
	});

	it("rejects a base the sender cannot read, on PATCH too", async () => {
		const { user: owner } = await createTestUser();
		const { user: sender, locals: senderLocals } = await createTestUser();
		await makeBase(owner._id, FOREIGN_BASE_ID);
		const conv = await createTestConversation(senderLocals);

		await expect(
			patchConversationV2({
				locals: senderLocals,
				params: { id: conv._id.toString() },
				request: new Request("http://localhost/api/v2/conversations/x", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ knowledgeBaseIds: [FOREIGN_BASE_ID] }),
				}),
			} as never)
		).rejects.toMatchObject({ status: 400 });
	});
});

describe("reading attached bases back", () => {
	it("resolves stored ids to name pairs for the owner", async () => {
		const { user, locals } = await createTestUser();
		await makeBase(user._id, OWNED_BASE_ID, "Specs");
		const conv = await createTestConversation(locals, { knowledgeBaseIds: [OWNED_BASE_ID] });

		const response = await getConversationV2({
			locals,
			params: { id: conv._id.toString() },
			url: new URL("http://localhost/api/v2/conversations/x"),
		} as never);
		const payload = superjson.parse<{ knowledgeBases?: { id: string; name: string }[] }>(
			await response.text()
		);
		expect(payload.knowledgeBases).toEqual([{ id: OWNED_BASE_ID, name: "Specs" }]);
	});

	it("tells a shared view nothing about the owner's bases", async () => {
		const { user, locals } = await createTestUser();
		await makeBase(user._id, OWNED_BASE_ID, "Specs");
		const conv = await createTestConversation(locals, {
			knowledgeBaseIds: [OWNED_BASE_ID],
			meta: { fromShareId: "abc1234" },
		});

		const response = await getConversationV2({
			locals,
			params: { id: conv._id.toString() },
			url: new URL("http://localhost/api/v2/conversations/x?fromShare=abc1234"),
		} as never);
		const payload = superjson.parse<{ knowledgeBases?: unknown }>(await response.text());
		expect(payload.knowledgeBases).toBeUndefined();
	});
});
