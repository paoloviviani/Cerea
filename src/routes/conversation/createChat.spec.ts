/**
 * Starting a chat when an earlier first send failed without a word: the failed
 * chat is replaced, not stacked beside the new one, and the response names it so
 * the sidebar can drop it. A chat the user went on with stays.
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
	resolveConversationModel: async () => ({ model: { id: "m", preprompt: "" } }),
}));
vi.mock("$lib/server/visibleModels", () => ({
	isSelectableCatalogueId: () => true,
	modelsFor: async () => [],
}));

import { collections, ready } from "$lib/server/database";
import { cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import { MessageUpdateStatus, MessageUpdateType } from "$lib/types/MessageUpdate";
import { POST } from "./+server";

beforeAll(async () => {
	await ready;
}, 30000);
afterEach(cleanupTestData);

const t = new Date();
const base = { createdAt: t, updatedAt: t, children: [], ancestors: [] };
const failedTurn = (text = "") => [
	{ ...base, id: "s", from: "system", content: "" },
	{ ...base, id: "u", from: "user", content: "Hello, can you help me draft a plan?" },
	{
		...base,
		id: "a",
		from: "assistant",
		content: text,
		updates: [
			{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Error, message: "quota" },
		],
	},
];
async function chat(sessionId: string, messages = failedTurn()) {
	const _id = new ObjectId();
	await collections.conversations.insertOne({
		_id,
		title: "New Chat",
		rootMessageId: "s",
		model: "m",
		messages,
		createdAt: new Date(),
		updatedAt: new Date(),
		sessionId,
	} as never);
	return _id.toString();
}
const create = async (sessionId: string) => {
	const res = await POST({
		locals: { sessionId },
		request: new Request("http://localhost/conversation", {
			method: "POST",
			body: JSON.stringify({ model: "m" }),
		}),
	} as never);
	return (await res.json()) as { conversationId: string; replaced: string[] };
};

describe("creating a chat after failed first sends", () => {
	it("three failed attempts leave one chat, not three", async () => {
		await chat("s1");
		const first = await create("s1");
		expect(first.replaced).toHaveLength(1);
		// The new chat's own first send fails too, then the user retries.
		await collections.conversations.updateOne(
			{ _id: new ObjectId(first.conversationId) },
			{ $set: { messages: failedTurn() as never } }
		);
		const second = await create("s1");
		expect(second.replaced).toEqual([first.conversationId]);
		expect(await collections.conversations.countDocuments({ sessionId: "s1" })).toBe(1);
	});

	it("keeps a chat that got an answer, and another user's failed chat", async () => {
		const answered = await chat("s2", failedTurn("Here is a plan."));
		const theirs = await chat("s3");
		const out = await create("s2");
		expect(out.replaced).toEqual([]);
		const ids = (await collections.conversations.find({}).toArray()).map((c) => c._id.toString());
		expect(ids).toEqual(expect.arrayContaining([answered, theirs, out.conversationId]));
	});
});
