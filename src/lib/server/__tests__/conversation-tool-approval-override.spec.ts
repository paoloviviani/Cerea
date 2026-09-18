/**
 * Deciding up front: the composer's tool-approval pill rides into the create
 * request, so a new chat can carry its override from birth instead of
 * inheriting forever. Absent means absent — the chat follows the setting
 * live, and "no override" and "override: unset" must mean the same thing to
 * every reader of the collection.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import superjson from "superjson";

import { collections, ready } from "$lib/server/database";
import { createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { POST as createConversation } from "../../../routes/conversation/+server";

const MODEL_ID = "test-org/test-model";

const createdUserIds: ObjectId[] = [];
const createdConvIds: ObjectId[] = [];

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await Promise.all([
		collections.conversations.deleteMany({ _id: { $in: createdConvIds } }),
		collections.users.deleteMany({ _id: { $in: createdUserIds } }),
		collections.sessions.deleteMany({ userId: { $in: createdUserIds } }),
	]);
	createdUserIds.length = 0;
	createdConvIds.length = 0;
});

async function createChat(locals: App.Locals, body: Record<string, unknown>) {
	const response = await createConversation({
		locals,
		request: new Request("http://localhost/conversation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as never);
	const { conversationId } = (await response.clone().json()) as { conversationId: string };
	createdConvIds.push(new ObjectId(conversationId));
	return response;
}

describe("tool-approval override at conversation create", () => {
	it("stores an explicit choice and hands it to the seed", async () => {
		const { locals } = await createTestUser().then((r) => {
			createdUserIds.push(r.user._id);
			return r;
		});

		const response = await createChat(locals, {
			model: MODEL_ID,
			toolApprovalOverride: "always-allow",
		});
		expect(response.status).toBe(200);

		const { conversationId, conversation } = (await response.json()) as {
			conversationId: string;
			conversation: string;
		};
		const conv = await collections.conversations.findOne({
			_id: new ObjectId(conversationId),
		});
		expect(conv?.toolApprovalOverride).toBe("always-allow");
		const seed = superjson.parse<{ toolApprovalOverride?: string }>(conversation);
		expect(seed.toolApprovalOverride).toBe("always-allow");
	});

	it("stores no field when the composer sent none", async () => {
		const { locals } = await createTestUser().then((r) => {
			createdUserIds.push(r.user._id);
			return r;
		});

		const response = await createChat(locals, { model: MODEL_ID });
		expect(response.status).toBe(200);

		const { conversationId } = (await response.json()) as { conversationId: string };
		const conv = await collections.conversations.findOne({
			_id: new ObjectId(conversationId),
		});
		expect(conv).not.toHaveProperty("toolApprovalOverride");
	});

	it("rejects an unknown override value", async () => {
		const { locals } = await createTestUser().then((r) => {
			createdUserIds.push(r.user._id);
			return r;
		});

		// The route throws SvelteKit's error(400) rather than returning a
		// 400 response, so the rejection (not a status) is the assertion.
		const err = await createChat(locals, {
			model: MODEL_ID,
			toolApprovalOverride: "sometimes",
		}).catch((e) => e as { status?: number });
		expect(err?.status).toBe(400);
	});
});
