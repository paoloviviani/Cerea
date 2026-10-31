import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { sweepOrphanAttachments } from "./orphanAttachments";
import { putBlob, removeBlobs } from "$lib/server/blobs/testing";

beforeAll(async () => {
	await ready;
}, 30000);

const owners: string[] = [];
afterEach(async () => {
	await collections.projects.deleteMany({});
	await removeBlobs({ "metadata.conversation": { $in: owners.splice(0) } });
});

async function put(owner: string) {
	owners.push(owner);
	await putBlob(`${owner}-x`, { conversation: owner }, "b");
}

describe("the orphan sweep and `project:<id>` keys", () => {
	it("removes a deleted project's files and leaves a live project's alone", async () => {
		const live = new ObjectId();
		const gone = new ObjectId();
		await collections.projects.insertOne({
			_id: live,
			userId: new ObjectId(),
			name: "P",
			shares: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		await put(`project:${live}`);
		await put(`project:${gone}`);

		await sweepOrphanAttachments(new Date(Date.now() + 48 * 60 * 60 * 1000));

		expect(
			await collections.blobStore.count("files", { "metadata.conversation": `project:${live}` })
		).toBe(1);
		expect(
			await collections.blobStore.count("files", { "metadata.conversation": `project:${gone}` })
		).toBe(0);
	});
});
