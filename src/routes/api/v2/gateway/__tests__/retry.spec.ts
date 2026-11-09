/**
 * Retrying one failed document: `POST vector_stores/{id}/files/{docId}/retry`.
 * Same reach as uploading: the owner and an editor may; a viewer
 * and a stranger are refused with 404, as for an upload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { POST } from "../[...path]/+server";

vi.mock("$lib/server/admin", () => ({
	callerIdentity: async (locals: App.Locals) => ({
		email: locals.user?.email ?? null,
		groups: [],
		isAdmin: false,
	}),
}));

await ready;

const owner = { _id: new ObjectId(), email: "owner@example.org" };
const editor = { _id: new ObjectId(), email: "editor@example.org" };
const viewer = { _id: new ObjectId(), email: "viewer@example.org" };
const stranger = { _id: new ObjectId(), email: "stranger@example.org" };

let storeId: ObjectId;
let otherStoreId: ObjectId;
let docId: ObjectId;

function retry(who: { _id: ObjectId; email: string }, store: ObjectId, doc: ObjectId) {
	const path = `vector_stores/${store}/files/${doc}/retry`;
	return POST({
		params: { path },
		url: new URL(`http://localhost/api/v2/gateway/${path}`),
		locals: { user: who, token: "tok" },
		request: new Request(`http://localhost/api/v2/gateway/${path}`, { method: "POST" }),
	} as unknown as Parameters<typeof POST>[0]);
}

async function seedStore(): Promise<ObjectId> {
	const _id = new ObjectId();
	await collections.vectorStores.insertOne({
		_id,
		name: "retry",
		description: "",
		ownerId: owner._id,
		embeddingModel: "embed-1",
		dimensions: null,
		chunkChars: 1200,
		chunkOverlap: 150,
		shares: [
			{ kind: "user", principal: editor.email, role: "editor" },
			{ kind: "user", principal: viewer.email, role: "viewer" },
		],
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	return _id;
}

beforeEach(async () => {
	await collections.knowledgeConfig.deleteMany({});
	await collections.knowledgeConfig.insertOne({
		embeddingModel: "embed-1",
		chunkChars: 1200,
		chunkOverlap: 150,
		enabled: true,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	storeId = await seedStore();
	otherStoreId = await seedStore();
	docId = new ObjectId();
	await collections.knowledgeDocuments.insertOne({
		_id: docId,
		storeId,
		title: "notes",
		text: "",
		chars: 0,
		chunkCount: 0,
		status: "failed",
		error: "quota",
		embeddingModel: null,
		indexedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
});

afterEach(async () => {
	await collections.vectorStores.deleteMany({ _id: { $in: [storeId, otherStoreId] } });
	await collections.knowledgeDocuments.deleteMany({ storeId: { $in: [storeId, otherStoreId] } });
	await collections.knowledgeConfig.deleteMany({});
});

describe("retry a failed document", () => {
	it("starts it again for the owner and for an editor", async () => {
		for (const who of [owner, editor]) {
			await collections.knowledgeDocuments.updateOne(
				{ _id: docId },
				{ $set: { status: "failed", error: "quota" } }
			);
			const res = await retry(who, storeId, docId);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.id).toBe(docId.toString());
			expect(body.error).toBeNull();
		}
	});

	it("refuses a viewer", async () => {
		// The same answer as an upload by a viewer: `reachableStore(..., "editor")`
		// does not match a viewer share at all, so it reads as "no such base".
		const res = await retry(viewer, storeId, docId);
		expect(res.status).toBe(404);
		const row = await collections.knowledgeDocuments.findOne({ _id: docId });
		expect(row?.status).toBe("failed");
	});

	it("tells a stranger the base does not exist", async () => {
		const res = await retry(stranger, storeId, docId);
		expect(res.status).toBe(404);
		const row = await collections.knowledgeDocuments.findOne({ _id: docId });
		expect(row?.status).toBe("failed");
	});

	it("does not reach a document of another base", async () => {
		const res = await retry(owner, otherStoreId, docId);
		expect(res.status).toBe(404);
	});
});

describe("create base body guard", () => {
	it.each(["null", "[]", '"text"', "not json"])("answers 400 for the body %s", async (raw) => {
		const path = "vector_stores";
		await expect(
			POST({
				params: { path },
				url: new URL(`http://localhost/api/v2/gateway/${path}`),
				locals: { user: owner, token: "tok" },
				request: new Request(`http://localhost/api/v2/gateway/${path}`, {
					method: "POST",
					body: raw,
				}),
			} as unknown as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 400 });
	});
});
