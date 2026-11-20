/**
 * Retrying one failed document: `POST vector_stores/{id}/files/{docId}/retry`.
 * Same reach as uploading: the owner and an editor may; a viewer
 * and a stranger are refused with 404, as for an upload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { POST } from "../[...path]/+server";

/**
 * A retry answers with the row as it is the moment the response is read, and the ingest it started runs
 * behind it. Left alone that ingest ends within milliseconds (here it fails: there is no vector database),
 * so whether the answer said "pending" or already "failed" depended on which got to Mongo first. The
 * ingest's first vector-database call (`ensureSchema`) waits on `gate` instead, so the answer is always the claimed row; the
 * `afterEach` lets it finish and waits for it, so nothing outlives the test.
 */
const gate = vi.hoisted(() => {
	const state = {
		open: false,
		release: () => {},
		wait: undefined as Promise<void> | undefined,
		reset() {
			state.open = false;
			state.wait = new Promise<void>((resolve) => {
				state.release = () => {
					state.open = true;
					resolve();
				};
			});
		},
	};
	return state;
});
vi.mock("$lib/server/knowledge/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/knowledge/db")>();
	return {
		...actual,
		ensureSchema: async () => {
			await gate.wait;
			throw new Error("no vector database in this test");
		},
	};
});

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
	gate.reset();
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
	vi.restoreAllMocks();
	// Let the ingest the retry started end, and wait until it has, before its rows go.
	gate.release();
	await vi.waitFor(async () => {
		const open = await collections.knowledgeDocuments.countDocuments({
			storeId: { $in: [storeId, otherStoreId] },
			status: "pending",
		});
		expect(open).toBe(0);
	});
	await collections.vectorStores.deleteMany({ _id: { $in: [storeId, otherStoreId] } });
	await collections.knowledgeDocuments.deleteMany({ storeId: { $in: [storeId, otherStoreId] } });
	await collections.knowledgeConfig.deleteMany({});
});

describe("retry a failed document", () => {
	it("starts it again for the owner and for an editor", async () => {
		// A slow runner: the answer's own read of the row comes well after the ingest has had its turn.
		// (The ingest is held at `gate`, so that turn changes nothing.)
		const realFind = collections.knowledgeDocuments.findOne.bind(collections.knowledgeDocuments);
		let sinceClaim = 0;
		const realUpdate = collections.knowledgeDocuments.updateOne.bind(
			collections.knowledgeDocuments
		);
		vi.spyOn(collections.knowledgeDocuments, "updateOne").mockImplementation(((
			...args: Parameters<typeof realUpdate>
		) => {
			if (JSON.stringify(args[1]).includes('"pending"')) sinceClaim = 0;
			return realUpdate(...args);
		}) as typeof realUpdate);
		vi.spyOn(collections.knowledgeDocuments, "findOne").mockImplementation((async (
			...args: Parameters<typeof realFind>
		) => {
			sinceClaim += 1;
			// The first read after a claim is the ingest's own; the second is the answer's.
			if (sinceClaim === 2) await new Promise((resolve) => setTimeout(resolve, 250));
			return realFind(...args);
		}) as typeof realFind);
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
			expect(body.status).toBe("pending");
		}
	});

	it("answers with the row as it is, even when the ingest has already failed again", async () => {
		gate.release();
		const res = await retry(owner, storeId, docId);
		expect(res.status).toBe(200);
		await vi.waitFor(async () => {
			const row = await collections.knowledgeDocuments.findOne({ _id: docId });
			expect(row?.status).toBe("failed");
			expect(row?.error).toBe("Indexing failed.");
		});
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
