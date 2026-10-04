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

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
	await collections.projects.deleteMany({});
});

describe("DELETE /api/v2/projects/[id]", () => {
	it("keeps the project's chats and returns them to the ordinary list, files and shares untouched", async () => {
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
		for (const owner of [inside._id.toString(), loose._id.toString(), "shareIn1"]) {
			const upload = collections.bucket.openUploadStream(`${owner}-x`, {
				metadata: { conversation: owner },
			});
			upload.end(Buffer.from("b"));
			await new Promise((resolve) => upload.once("finish", resolve));
		}
		await collections.sharedConversations.insertOne({
			_id: "shareIn1",
			hash: "h",
			createdAt: new Date(),
			updatedAt: new Date(),
			rootMessageId: "r",
			messages: [],
			title: "t",
			model: "m",
			conversationId: inside._id,
		});

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
		expect(await collections.sharedConversations.countDocuments({})).toBe(1);
		expect(await collections.bucketFiles.countDocuments({})).toBe(3);
	});
});
