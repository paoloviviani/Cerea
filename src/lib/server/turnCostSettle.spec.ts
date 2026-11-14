import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";
import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { settleTurnCost } from "./turnCostSettle";
import { turnGatewayCost } from "./turnCost";

const ASSISTANT = "22222222-2222-4222-8222-222222222222";
const USER_MSG = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => {
	await ready;
}, 30000);
afterEach(cleanupTestData);

async function setup(stats?: Record<string, unknown>) {
	const owner = await createTestUser();
	return createTestConversation(owner.locals, {
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
}

const stored = async (id: ObjectId) =>
	(await collections.conversations.findOne({ _id: id }))?.messages.find((m) => m.id === ASSISTANT)
		?.stats;
const settled = (read: ReturnType<typeof vi.fn>) =>
	vi
		.waitFor(() => expect(read).toHaveBeenCalled())
		.then(() => new Promise((r) => setTimeout(r, 50)));

describe("settleTurnCost", () => {
	it("stores the settled cost over the provisional one, keeping the rest of the stats", async () => {
		const chat = await setup({ cost: "0.0010 USD", inputTokens: 9, subAgentCalls: 2 });
		const read = vi.fn(async () => ({
			status: "ok" as const,
			cost: "0.0042",
			currency: "USD",
			requests: 4,
		}));
		settleTurnCost({ conversationId: chat._id, messageId: ASSISTANT, token: "tok", read });
		await vi.waitFor(async () =>
			expect(await stored(chat._id)).toMatchObject({
				cost: "0.0042",
				costCurrency: "USD",
				costSource: "gateway",
				inputTokens: 9,
				subAgentCalls: 2,
			})
		);
		expect(read).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith("tok", ASSISTANT);
	});

	it("keeps the in-stream sum when nothing settled or the gateway is unavailable", async () => {
		for (const result of [{ status: "pending" }, { status: "unavailable" }]) {
			const chat = await setup({ cost: "0.0010 USD" });
			const read = vi.fn(async () => result as never);
			settleTurnCost({ conversationId: chat._id, messageId: ASSISTANT, token: "tok", read });
			await settled(read);
			expect(await stored(chat._id)).toEqual({ cost: "0.0010 USD" });
		}
	});

	it("keeps the in-stream sum for a gateway without tags (404) or none (503)", async () => {
		for (const status of [404, 503]) {
			const chat = await setup({ cost: "0.0010 USD" });
			const read = vi.fn((token: string, id: string) =>
				turnGatewayCost(token, id, { sleep: async () => {} })
			);
			const spy = vi.spyOn(gateway, "get");
			spy.mockRejectedValue(new GatewayCallFailed(status, "nope"));
			settleTurnCost({ conversationId: chat._id, messageId: ASSISTANT, token: "tok", read });
			await settled(read);
			spy.mockRestore();
			expect(await stored(chat._id)).toEqual({ cost: "0.0010 USD" });
		}
	});

	it("does nothing without a token, and never throws", async () => {
		const chat = await setup({ cost: "0.0010 USD" });
		const read = vi.fn();
		settleTurnCost({ conversationId: chat._id, messageId: ASSISTANT, token: undefined, read });
		expect(read).not.toHaveBeenCalled();
		const failing = vi.fn(async () => {
			throw new Error("boom");
		});
		expect(() =>
			settleTurnCost({ conversationId: chat._id, messageId: ASSISTANT, token: "t", read: failing })
		).not.toThrow();
		await settled(failing);
		expect(await stored(chat._id)).toEqual({ cost: "0.0010 USD" });
	});
});
