import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import { MessageUpdateStatus, MessageUpdateType } from "$lib/types/MessageUpdate";
import { isAbandonedFirstChat, removeAbandonedFirstChats } from "./abandonedFirstChats";

beforeAll(async () => {
	await ready;
}, 30000);
afterEach(cleanupTestData);

const base = { createdAt: new Date(), updatedAt: new Date(), children: [], ancestors: [] };
const sys = { ...base, id: "s", from: "system", content: "" };
const user = { ...base, id: "u", from: "user", content: "Hello" };
const failed = (content = "") => ({
	...base,
	id: "a",
	from: "assistant",
	content,
	updates: [
		{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Error, message: "quota" },
	],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const conv = (over: Record<string, any> = {}) => ({
	_id: new ObjectId(),
	title: "New Chat",
	rootMessageId: "s",
	model: "m",
	preprompt: "",
	messages: [sys, user, failed()],
	createdAt: new Date(),
	updatedAt: new Date(),
	sessionId: "sess-1",
	...over,
});

describe("isAbandonedFirstChat", () => {
	it("is a first exchange that failed with no text", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(isAbandonedFirstChat(conv() as any)).toBe(true);
	});
	it("is not once the reply has text, or after a rename", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(isAbandonedFirstChat(conv({ messages: [sys, user, failed("Hi")] }) as any)).toBe(false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(isAbandonedFirstChat(conv({ titleSource: "user" }) as any)).toBe(false);
	});
	it("is not one still generating (no error yet)", () => {
		const running = { ...failed(), updates: [] };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(isAbandonedFirstChat(conv({ messages: [sys, user, running] }) as any)).toBe(false);
	});
});

describe("removeAbandonedFirstChats", () => {
	it("removes the owner's failed first chats only", async () => {
		const mine = conv();
		const kept = conv({ messages: [sys, user, failed("Hi")] });
		const projectChat = conv({ projectId: new ObjectId() });
		const others = conv({ sessionId: "sess-2" });
		const old = conv({ createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await collections.conversations.insertMany([mine, kept, projectChat, others, old] as any);
		const removed = await removeAbandonedFirstChats({ sessionId: "sess-1" });
		expect(removed).toEqual([mine._id.toString()]);
		expect(await collections.conversations.countDocuments({})).toBe(4);
	});
});
