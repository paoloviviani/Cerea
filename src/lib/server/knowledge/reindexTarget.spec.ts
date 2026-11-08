import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { KnowledgeError, reindexTarget, type Caller } from "./service";

await ready;

const owner: Caller = {
	userId: new ObjectId(),
	email: "owner@example.org",
	groups: [],
	isAdmin: false,
};
const editor: Caller = {
	userId: new ObjectId(),
	email: "editor@example.org",
	groups: [],
	isAdmin: false,
};
const admin: Caller = {
	userId: new ObjectId(),
	email: "admin@example.org",
	groups: [],
	isAdmin: true,
};

let storeId: ObjectId;

beforeEach(async () => {
	storeId = new ObjectId();
	await collections.vectorStores.insertOne({
		_id: storeId,
		name: "reindex-target",
		description: "",
		ownerId: owner.userId,
		embeddingModel: "old-embedder",
		dimensions: null,
		chunkChars: 1200,
		chunkOverlap: 150,
		shares: [{ kind: "user", principal: editor.email ?? "", role: "editor" }],
		createdAt: new Date(),
		updatedAt: new Date(),
	});
});

afterEach(async () => {
	await collections.vectorStores.deleteMany({ _id: storeId });
});

async function status(p: Promise<unknown>): Promise<number | "ok"> {
	try {
		await p;
		return "ok";
	} catch (err) {
		if (err instanceof KnowledgeError) return err.status;
		throw err;
	}
}

describe("reindexTarget", () => {
	it("lets the owner reindex their base", async () => {
		expect((await reindexTarget(storeId.toString(), owner))._id.equals(storeId)).toBe(true);
	});

	it("keeps the owner-only rule for users, editors included", async () => {
		expect(await status(reindexTarget(storeId.toString(), editor))).toBe(403);
		expect(await status(reindexTarget(storeId.toString(), admin))).toBe(404);
	});

	it("lets an administrator reindex any user's base from the admin screen", async () => {
		const base = await reindexTarget(storeId.toString(), admin, { asAdmin: true });
		expect(base.ownerId.equals(owner.userId)).toBe(true);
	});

	it("still answers 404 for a base that does not exist or a malformed id", async () => {
		expect(await status(reindexTarget(new ObjectId().toString(), admin, { asAdmin: true }))).toBe(
			404
		);
		expect(await status(reindexTarget("not-an-id", admin, { asAdmin: true }))).toBe(404);
	});
});
