import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import superjson from "superjson";

const { regenerate } = vi.hoisted(() => ({ regenerate: vi.fn() }));
vi.mock("$lib/server/textGeneration/title", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/textGeneration/title")>();
	return { ...actual, regenerateTitle: regenerate };
});

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

beforeEach(() => regenerate.mockReset());
afterEach(async () => {
	await cleanupTestData();
});

async function post(id: string, locals: Partial<App.Locals>) {
	return testRequest(POST, {
		method: "POST",
		path: `/api/v2/conversations/${id}/title`,
		params: { id },
		locals,
	});
}

describe("POST /api/v2/conversations/[id]/title", () => {
	it("stores the model's new title and marks it as a model's", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals, { title: "old", titleSource: "fallback" });
		regenerate.mockResolvedValue({ ok: true, title: "A better title" });

		const res = await post(conv._id.toString(), locals);

		expect(res.status).toBe(200);
		expect(superjson.parse<{ title: string }>(await res.text()).title).toBe("A better title");
		const stored = await collections.conversations.findOne({ _id: conv._id });
		expect(stored).toMatchObject({ title: "A better title", titleSource: "model" });
	});

	it("never replaces a title the user typed: 409, and the title is untouched", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals, { title: "Mine", titleSource: "user" });
		regenerate.mockResolvedValue({ ok: false, reason: "user-title" });

		const res = await post(conv._id.toString(), locals);

		expect(res.status).toBe(409);
		expect((await collections.conversations.findOne({ _id: conv._id }))?.title).toBe("Mine");
	});

	it("a rename that lands while the model works still wins", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals, { title: "old", titleSource: "model" });
		regenerate.mockImplementation(async () => {
			await collections.conversations.updateOne(
				{ _id: conv._id },
				{ $set: { title: "Typed meanwhile", titleSource: "user" } }
			);
			return { ok: true, title: "Too late" };
		});

		const res = await post(conv._id.toString(), locals);

		expect(res.status).toBe(409);
		expect((await collections.conversations.findOne({ _id: conv._id }))?.title).toBe(
			"Typed meanwhile"
		);
	});

	it("says so, and keeps the title, when no title could be written", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals, { title: "old" });
		regenerate.mockResolvedValue({ ok: false, reason: "unavailable" });

		const res = await post(conv._id.toString(), locals);

		expect(res.status).toBe(503);
		expect((await collections.conversations.findOne({ _id: conv._id }))?.title).toBe("old");
	});

	it("is the owner's only: another user's chat is a 404", async () => {
		const owner = await createTestUser();
		const other = await createTestUser();
		const conv = await createTestConversation(owner.locals, { title: "old" });

		const res = await post(conv._id.toString(), other.locals);

		expect(res.status).toBe(404);
		expect(regenerate).not.toHaveBeenCalled();
	});
});
