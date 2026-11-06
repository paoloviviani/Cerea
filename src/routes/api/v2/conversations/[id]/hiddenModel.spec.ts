/** PATCH with a model: re-sending the chat's own (now hidden) model is fine; a change TO a hidden one is not. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";

vi.mock("$lib/server/visibleModels", async (orig) => ({
	...(await orig<typeof import("$lib/server/visibleModels")>()),
	isSelectableCatalogueId: async (_l: unknown, id: string) => id !== "hidden-model",
}));
vi.mock("$lib/server/models", async (orig) => {
	const actual = await orig<typeof import("$lib/server/models")>();
	return { ...actual, validModelIdSchema: { safeParse: () => ({ success: true }) } };
});

import { PATCH } from "./+server";

beforeAll(async () => {
	await ready;
}, 30000);
afterEach(cleanupTestData);

async function patch(id: string, locals: Partial<App.Locals>, model: string) {
	return testRequest(PATCH, {
		path: `/api/v2/conversations/${id}`,
		method: "PATCH",
		params: { id },
		locals,
		body: JSON.stringify({ model }),
		headers: { "content-type": "application/json" },
	} as never);
}

describe("PATCH /api/v2/conversations/[id] model", () => {
	it("allows re-sending the chat's current model even when it is hidden", async () => {
		const owner = await createTestUser();
		const chat = await createTestConversation(owner.locals, { model: "hidden-model" });
		const res = await patch(chat._id.toString(), owner.locals, "hidden-model");
		expect(res.status).toBe(200);
		expect((await collections.conversations.findOne({ _id: chat._id }))?.model).toBe(
			"hidden-model"
		);
	});

	it("refuses a change to a hidden model", async () => {
		const owner = await createTestUser();
		const chat = await createTestConversation(owner.locals, { model: "test-model" });
		const res = await patch(chat._id.toString(), owner.locals, "hidden-model");
		expect(res.status).toBe(400);
		expect((await collections.conversations.findOne({ _id: chat._id }))?.model).toBe("test-model");
	});
});
