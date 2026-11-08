import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import superjson from "superjson";

const { turnGatewayCost } = vi.hoisted(() => ({ turnGatewayCost: vi.fn() }));
vi.mock("$lib/server/turnCost", () => ({ turnGatewayCost }));

import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { GET } from "./+server";

const ASSISTANT = "22222222-2222-4222-8222-222222222222";
const USER_MSG = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => {
	await ready;
}, 30000);
beforeEach(() => turnGatewayCost.mockReset());
afterEach(cleanupTestData);

async function setup(stats?: Record<string, unknown>) {
	const owner = await createTestUser();
	const chat = await createTestConversation(owner.locals, {
		messages: [
			{ id: USER_MSG, from: "user", content: "hi", children: [ASSISTANT] },
			{
				id: ASSISTANT,
				from: "assistant",
				content: "yo",
				ancestors: [USER_MSG],
				...(stats ? { stats } : {}),
			},
		] as never,
	});
	return { owner, chat };
}

async function ask(chat: { _id: ObjectId }, locals: Partial<App.Locals>, messageId = ASSISTANT) {
	const res = await testRequest(GET, {
		path: `/api/v2/conversations/${chat._id}/message/${messageId}/cost`,
		params: { id: chat._id.toString(), messageId },
		locals,
	});
	return {
		status: res.status,
		body: res.status === 200 ? superjson.parse<Record<string, unknown>>(await res.text()) : null,
	};
}

const stored = async (chat: { _id: ObjectId }) =>
	(await collections.conversations.findOne({ _id: chat._id }))?.messages.find(
		(m) => m.id === ASSISTANT
	)?.stats;

describe("GET .../message/:messageId/cost", () => {
	it("reads the gateway with the user's token and stores the cost on the message", async () => {
		const { owner, chat } = await setup({ model: "M", inputTokens: 5 });
		turnGatewayCost.mockResolvedValue({
			status: "ok",
			cost: "0.0042",
			currency: "EUR",
			requests: 2,
		});
		const { status, body } = await ask(chat, { ...owner.locals, token: "tok" });
		expect(status).toBe(200);
		expect(body).toEqual({ available: true, cost: "0.0042", currency: "EUR" });
		expect(turnGatewayCost).toHaveBeenCalledWith("tok", ASSISTANT);
		expect(await stored(chat)).toMatchObject({
			model: "M",
			inputTokens: 5,
			cost: "0.0042",
			costCurrency: "EUR",
		});
	});

	it("stores the cost on a message that had no stats at all", async () => {
		const { owner, chat } = await setup();
		turnGatewayCost.mockResolvedValue({ status: "ok", cost: "1.2", currency: null, requests: 1 });
		await ask(chat, { ...owner.locals, token: "tok" });
		expect(await stored(chat)).toEqual({ cost: "1.2" });
	});

	it("does not ask the gateway when a cost is already stored", async () => {
		const { owner, chat } = await setup({ cost: "0.5", costCurrency: "USD" });
		const { body } = await ask(chat, { ...owner.locals, token: "tok" });
		expect(body).toEqual({ available: true, cost: "0.5", currency: "USD" });
		expect(turnGatewayCost).not.toHaveBeenCalled();
	});

	it("says unavailable, and stores nothing, with no gateway or no token", async () => {
		const { owner, chat } = await setup();
		turnGatewayCost.mockResolvedValue({ status: "unavailable" });
		expect((await ask(chat, { ...owner.locals, token: "tok" })).body).toEqual({ available: false });
		expect((await ask(chat, { ...owner.locals, token: undefined })).body).toEqual({
			available: false,
		});
		expect(await stored(chat)).toBeUndefined();
	});

	it("says nothing settled, and stores nothing, so a later open asks again", async () => {
		const { owner, chat } = await setup();
		turnGatewayCost.mockResolvedValue({ status: "pending" });
		expect((await ask(chat, { ...owner.locals, token: "tok" })).body).toEqual({
			available: true,
			cost: null,
		});
		expect(await stored(chat)).toBeUndefined();
	});

	it("refuses another user's chat, an unknown message and a user message", async () => {
		const { chat } = await setup();
		const other = await createTestUser();
		expect((await ask(chat, { ...other.locals, token: "tok" })).status).toBeGreaterThanOrEqual(400);
		const { owner, chat: mine } = await setup();
		expect((await ask(mine, { ...owner.locals, token: "tok" }, "nope")).status).toBe(404);
		expect((await ask(mine, { ...owner.locals, token: "tok" }, USER_MSG)).status).toBe(400);
		expect(turnGatewayCost).not.toHaveBeenCalled();
	});
});
