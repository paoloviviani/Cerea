import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { POST } from "./+server";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
	await collections.sharedArtifacts.deleteMany({});
});

const message = (id: string, body: string) =>
	({
		id,
		from: "assistant",
		content: `<artifact identifier="notes" type="markdown" title="Notes">${body}</artifact>`,
		createdAt: new Date(),
		updatedAt: new Date(),
		children: [],
	}) as never;

const post = (locals: Partial<App.Locals>, body: unknown) =>
	testRequest(POST, {
		path: "/api/v2/artifacts/versions",
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		locals,
	});

describe("POST /api/v2/artifacts/versions", () => {
	it("deletes the older versions of the owner's artifact and answers with counts only", async () => {
		const owner = await createTestUser();
		const chat = await createTestConversation(owner.locals, {
			messages: [message("m1", "# one"), message("m2", "# two")],
		});
		const res = await post(owner.locals, {
			conversationId: chat._id.toString(),
			identifier: "notes",
			leafMessageId: "m2",
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ deleted: 1, keptShared: 0, freedFiles: 0, pruned: ["m1:0"] });
		expect(JSON.stringify(body)).not.toContain("# one");
	});

	it("is for the owner only", async () => {
		const owner = await createTestUser();
		const chat = await createTestConversation(owner.locals, {
			messages: [message("m1", "# one"), message("m2", "# two")],
		});
		const stranger = await createTestUser();
		const res = await post(stranger.locals, {
			conversationId: chat._id.toString(),
			identifier: "notes",
		});
		expect(res.status).toBe(404);
		const stored = await collections.conversations.findOne({ _id: chat._id });
		expect(stored?.prunedArtifactVersions).toBeUndefined();
	});

	it("needs a well-formed request", async () => {
		const owner = await createTestUser();
		expect((await post(owner.locals, { conversationId: "nope", identifier: "n" })).status).toBe(
			400
		);
	});
});
