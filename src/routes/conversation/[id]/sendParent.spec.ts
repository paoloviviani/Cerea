/**
 * A send whose parent message the server does not hold (a tab that sends in the
 * instant after a turn ends still has the ids it minted for its optimistic
 * messages, until its post-turn refresh swaps in the server's) is a 409 the
 * client can act on, never the 500 with the generic toast it used to be.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("$lib/server/models", () => ({
	defaultModel: { id: "m" },
	models: [],
	validateModel: () => ({ safeParse: () => ({ success: true }) }),
}));
vi.mock("$lib/server/hiddenModels", () => ({ isUnlistedForUsers: () => false }));
vi.mock("$lib/server/customModels", () => ({
	conversationOwnerFilter: () => ({}),
	isSelectableModel: async () => true,
	resolveConversationModel: async () => ({
		model: { id: "m", preprompt: "", getEndpoint: async () => ({}) },
	}),
}));
vi.mock("$lib/server/visibleModels", () => ({
	isSelectableCatalogueId: () => true,
	modelsFor: async () => [],
}));

import { collections, ready } from "$lib/server/database";
import { cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import { PARENT_NOT_FOUND_MESSAGE } from "$lib/utils/sendRefusals";
import { POST } from "./+server";

beforeAll(async () => {
	await ready;
}, 30000);
afterEach(cleanupTestData);

const t = new Date();
const base = { createdAt: t, updatedAt: t };
const U = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";

async function chat(sessionId: string) {
	const _id = new ObjectId();
	await collections.conversations.insertOne({
		_id,
		title: "New Chat",
		rootMessageId: U,
		model: "m",
		messages: [
			{ ...base, id: U, from: "user", content: "hi", ancestors: [], children: [A] },
			{ ...base, id: A, from: "assistant", content: "hello", ancestors: [U], children: [] },
		],
		createdAt: t,
		updatedAt: t,
		sessionId,
	} as never);
	return _id.toString();
}

const send = (id: string, sessionId: string, data: Record<string, unknown>) => {
	const form = new FormData();
	form.append("data", JSON.stringify(data));
	return POST({
		locals: { sessionId },
		params: { id },
		getClientAddress: () => "127.0.0.1",
		request: new Request("http://localhost/conversation/" + id, { method: "POST", body: form }),
	} as never);
};

describe("sending under a parent the server does not hold", () => {
	it("answers 409 with the sync message, and stores nothing", async () => {
		const id = await chat("s1");
		const unknownParent = "33333333-3333-4333-8333-333333333333";
		await expect(send(id, "s1", { inputs: "next", id: unknownParent })).rejects.toMatchObject({
			status: 409,
			body: { message: PARENT_NOT_FOUND_MESSAGE },
		});
		const stored = await collections.conversations.findOne({ _id: new ObjectId(id) });
		expect(stored?.messages).toHaveLength(2);
	});

	it("answers 400, not 500, when a non-first send names no parent", async () => {
		const id = await chat("s2");
		await expect(send(id, "s2", { inputs: "next" })).rejects.toMatchObject({ status: 400 });
	});
});
