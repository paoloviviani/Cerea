import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { DELETE } from "./[id]/+server";
import { putBlob } from "$lib/server/blobs/testing";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
	await collections.projects.deleteMany({});
});

describe("DELETE /api/v2/projects/[id]", () => {
	it("keeps the project's chats and returns them to the ordinary list, files untouched", async () => {
		const { user, locals } = await createTestUser();
		const projectId = new ObjectId();
		await collections.projects.insertOne({
			_id: projectId,
			userId: user._id,
			name: "P",
			instructions: "",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const inside = await createTestConversation(locals, { projectId });
		const loose = await createTestConversation(locals);
		for (const owner of [inside._id.toString(), loose._id.toString()]) {
			await putBlob(`${owner}-x`, { conversation: owner }, "b");
		}
		const res = await testRequest(DELETE, {
			path: `/api/v2/projects/${projectId}`,
			method: "DELETE",
			params: { id: projectId.toString() },
			locals,
		});

		expect(res.status).toBe(204);
		expect(await collections.projects.countDocuments({ _id: projectId })).toBe(0);
		const kept = await collections.conversations.findOne({ _id: inside._id });
		expect(kept).not.toBeNull();
		expect(kept?.projectId).toBeUndefined();
		expect(await collections.conversations.countDocuments({ _id: loose._id })).toBe(1);
		// Only this test's own files: other specs may still be tidying theirs.
		expect(
			await collections.blobStore.count("files", {
				"metadata.conversation": { $in: [inside._id.toString(), loose._id.toString()] },
			})
		).toBe(2);
	});
});
