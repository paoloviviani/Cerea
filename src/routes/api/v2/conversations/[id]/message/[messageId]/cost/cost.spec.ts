import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import superjson from "superjson";

const { turnGatewayCost } = vi.hoisted(() => ({ turnGatewayCost: vi.fn() }));
vi.mock("$lib/server/turnCost", () => ({ turnGatewayCost }));
const cfg = vi.hoisted(() => ({ USE_USER_TOKEN: "true", OPENAI_API_KEY: "" }));
vi.mock("$lib/server/config", async (orig) => {
	const real = await orig<typeof import("$lib/server/config")>();
	return {
		...real,
		config: new Proxy(real.config, {
			get: (t, k) => (k in cfg ? cfg[k as keyof typeof cfg] : Reflect.get(t, k)),
		}),
	};
});

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
beforeEach(() => {
	turnGatewayCost.mockReset();
	cfg.USE_USER_TOKEN = "true";
	cfg.OPENAI_API_KEY = "";
});
afterEach(cleanupTestData);

async function setup(stats?: Record<string, unknown>, flagged = false) {
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
				...(flagged ? { turnTagVersion: 2 } : {}),
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
		expect(turnGatewayCost).toHaveBeenCalledWith(
			"tok",
			ASSISTANT,
			expect.objectContaining({ conversationId: String(chat._id) })
		);
		expect(await stored(chat)).toMatchObject({
			model: "M",
			inputTokens: 5,
			cost: "0.0042",
			costCurrency: "EUR",
			costSource: "gateway",
		});
	});

	it("tells the cost read whether the message carries the scoped tag", async () => {
		turnGatewayCost.mockResolvedValue({ status: "pending" });
		const legacy = await setup();
		await ask(legacy.chat, { ...legacy.owner.locals, token: "tok" });
		expect(turnGatewayCost).toHaveBeenLastCalledWith(
			"tok",
			ASSISTANT,
			expect.objectContaining({ scopedTag: false })
		);
		const flagged = await setup(undefined, true);
		await ask(flagged.chat, { ...flagged.owner.locals, token: "tok" });
		expect(turnGatewayCost).toHaveBeenLastCalledWith(
			"tok",
			ASSISTANT,
			expect.objectContaining({ scopedTag: true })
		);
	});

	it("uses the deployment's key when personal tokens are off", async () => {
		const { owner, chat } = await setup();
		cfg.USE_USER_TOKEN = "false";
		cfg.OPENAI_API_KEY = "sk-shared";
		turnGatewayCost.mockResolvedValue({ status: "pending" });
		await ask(chat, { ...owner.locals, token: undefined });
		expect(turnGatewayCost).toHaveBeenCalledWith(
			"sk-shared",
			ASSISTANT,
			expect.objectContaining({ conversationId: String(chat._id) })
		);
	});

	it("stores the cost on a message that had no stats at all", async () => {
		const { owner, chat } = await setup();
		turnGatewayCost.mockResolvedValue({ status: "ok", cost: "1.2", currency: null, requests: 1 });
		await ask(chat, { ...owner.locals, token: "tok" });
		expect(await stored(chat)).toEqual({ cost: "1.2", costSource: "gateway" });
	});

	it("does not ask the gateway when the settled cost is already stored", async () => {
		const { owner, chat } = await setup({
			cost: "0.5",
			costCurrency: "USD",
			costSource: "gateway",
		});
		const { body } = await ask(chat, { ...owner.locals, token: "tok" });
		expect(body).toEqual({ available: true, cost: "0.5", currency: "USD" });
		expect(turnGatewayCost).not.toHaveBeenCalled();
	});

	it("replaces a provisional in-stream cost with the gateway's settled one", async () => {
		const { owner, chat } = await setup({ cost: "0.0010 USD", inputTokens: 5 });
		turnGatewayCost.mockResolvedValue({
			status: "ok",
			cost: "0.0042",
			currency: "USD",
			requests: 3,
		});
		const { body } = await ask(chat, { ...owner.locals, token: "tok" });
		expect(body).toEqual({ available: true, cost: "0.0042", currency: "USD" });
		expect(await stored(chat)).toMatchObject({
			inputTokens: 5,
			cost: "0.0042",
			costCurrency: "USD",
			costSource: "gateway",
		});
	});

	it("keeps the in-stream cost when the gateway has no tags, no gateway, or has not settled", async () => {
		const { owner, chat } = await setup({ cost: "0.0010 USD" });
		for (const result of [{ status: "unavailable" }, { status: "pending" }]) {
			turnGatewayCost.mockResolvedValue(result);
			expect((await ask(chat, { ...owner.locals, token: "tok" })).body).toEqual({
				available: true,
				cost: "0.0010 USD",
				currency: null,
			});
		}
		// No token at all (a gateway that is not configured): the same.
		expect((await ask(chat, { ...owner.locals, token: undefined })).body).toMatchObject({
			cost: "0.0010 USD",
		});
		expect(await stored(chat)).toEqual({ cost: "0.0010 USD" });
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
