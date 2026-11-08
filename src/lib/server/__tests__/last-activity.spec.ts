/**
 * `lastActivityAt` is what the sidebar groups by: a user message and a finished
 * turn move it, nothing else does (housekeeping specs: the sweepers, the model
 * PATCH). The real route and Mongo; only the upstream is scripted.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { streamFor } from "$lib/server/textGeneration/__tests__/replayHarness";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("openai", async (importOriginal) => ({
	...(await importOriginal<typeof import("openai")>()),
	OpenAI: class {
		chat = { completions: { create: mocks.create } };
	},
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

const { POST } = await import("../../../routes/conversation/[id]/+server");

const OLD = new Date("2026-01-01T10:00:00Z");

beforeAll(async () => {
	await ready;
});
beforeEach(() => mocks.create.mockReset());
afterEach(cleanupTestData);

describe.sequential("lastActivityAt on a chat turn", () => {
	it("moves when the user sends, and again when the turn completes", async () => {
		const { locals } = await createTestUser();
		const rootId = crypto.randomUUID();
		const conv = await createTestConversation(locals, {
			model: "test-org/test-model",
			title: "t",
			rootMessageId: rootId,
			lastActivityAt: OLD,
			messages: [
				{
					id: rootId,
					from: "system",
					content: "",
					ancestors: [],
					children: [],
					createdAt: OLD,
					updatedAt: OLD,
				},
			],
		});

		// What the first upstream call sees is the state after the user's message was
		// saved and before the answer was: the send has moved it, the completion has not.
		let atFirstCall: Date | undefined;
		mocks.create.mockImplementation(async () => {
			atFirstCall ??= (await collections.conversations.findOne({ _id: conv._id }))?.lastActivityAt;
			await new Promise((resolve) => setTimeout(resolve, 20));
			return streamFor({ content: "ok" });
		});

		const form = new FormData();
		form.set("data", JSON.stringify({ inputs: "hello", id: rootId }));
		const response = await POST({
			request: new Request(`http://localhost/conversation/${conv._id}`, {
				method: "POST",
				body: form,
			}),
			locals,
			params: { id: conv._id.toString() },
			getClientAddress: () => "127.0.0.1",
		} as never);
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		for (;;) if (!reader || (await reader.read()).done) break;

		const afterTurn = (await collections.conversations.findOne({ _id: conv._id }))?.lastActivityAt;
		expect(atFirstCall?.getTime()).toBeGreaterThan(OLD.getTime());
		expect(afterTurn?.getTime()).toBeGreaterThan(atFirstCall?.getTime() ?? Infinity);
	});
});
