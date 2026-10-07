/**
 * Custom models over their own routes: created, listed, edited and deleted by
 * the owner only; unique by name per owner; based only on a catalogue model the
 * caller can see; and private — another person's id is a 404, never a 403.
 *
 * Driven through `testRequest` so the handle hook's auth runs as in production.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import superjson from "superjson";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestLocals, createTestUser } from "./testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { GET, POST } from "../../../../routes/api/v2/custom-models/+server";
import {
	DELETE,
	GET as GET_ONE,
	PATCH,
} from "../../../../routes/api/v2/custom-models/[id]/+server";
import { GET as settingsGET } from "../../../../routes/api/v2/user/settings/+server";
import { PATCH as patchConversation } from "../../../../routes/api/v2/conversations/[id]/+server";
import { PATCH as patchConversationLegacy } from "../../../../routes/conversation/[id]/+server";
import { POST as shareConversation } from "../../../../routes/conversation/[id]/share/+server";
import type { CustomModelView } from "$lib/types/CustomModel";

const BASE = "test-org/test-model";
const OTHER_BASE = "test-org/text-only";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
});

function body(method: string, payload: unknown) {
	return {
		method,
		body: JSON.stringify(payload),
		headers: { "Content-Type": "application/json" },
	} as const;
}

const valid = { name: "Menu helper", baseModelId: BASE, systemPrompt: "Plan menus." };

async function create(locals: App.Locals, payload: Record<string, unknown> = valid) {
	return testRequest(POST, { path: "/api/v2/custom-models", locals, ...body("POST", payload) });
}

async function created(locals: App.Locals, payload: Record<string, unknown> = valid) {
	const res = await create(locals, payload);
	expect(res.status).toBe(201);
	return ((await res.json()) as { data: CustomModelView }).data;
}

const one = (locals: App.Locals, id: string, method: string, payload?: unknown) =>
	testRequest(method === "PATCH" ? PATCH : method === "DELETE" ? DELETE : GET_ONE, {
		path: `/api/v2/custom-models/${id}`,
		params: { id },
		locals,
		...(payload === undefined ? { method } : body(method, payload)),
	});

describe("POST /api/v2/custom-models", () => {
	it("creates a model under a collision-proof `custom:<objectId>` id, owned by the caller", async () => {
		const { user, locals } = await createTestUser();
		const model = await created(locals, { ...valid, description: "Lunch plans" });
		expect(model).toMatchObject({
			name: "Menu helper",
			baseModelId: BASE,
			systemPrompt: "Plan menus.",
			description: "Lunch plans",
		});
		expect(model.id).toMatch(/^custom:[0-9a-f]{24}$/);
		const row = await collections.customModels.findOne({ userId: user._id });
		expect(row?.nameKey).toBe("menu helper");
	});

	it("takes a null description, which is what the form sends when it is left empty", async () => {
		const { locals } = await createTestUser();
		const model = await created(locals, { ...valid, description: null });
		expect(model.description).toBeUndefined();
	});

	it("401s without an owner", async () => {
		const res = await create(createTestLocals({ sessionId: undefined }));
		expect(res.status).toBe(401);
	});

	it("keeps names unique per owner, ignoring case — but not across owners", async () => {
		const first = await createTestUser();
		const second = await createTestUser();
		await created(first.locals);
		expect((await create(first.locals, { ...valid, name: "  MENU HELPER " })).status).toBe(409);
		expect((await create(second.locals)).status).toBe(201);
		expect(await collections.customModels.countDocuments({})).toBe(2);
	});

	it("needs a base that exists and is a catalogue model", async () => {
		const { locals } = await createTestUser();
		const unknown = await create(locals, { ...valid, baseModelId: "nobody/nothing" });
		expect(unknown.status).toBe(400);

		const first = await created(locals);
		const chained = await create(locals, { ...valid, name: "Second", baseModelId: first.id });
		expect(chained.status).toBe(400);
		expect(await collections.customModels.countDocuments({})).toBe(1);
	});

	it("rejects an empty name or prompt, and stores nothing", async () => {
		const { locals } = await createTestUser();
		expect((await create(locals, { ...valid, name: "   " })).status).toBe(400);
		expect((await create(locals, { ...valid, systemPrompt: "" })).status).toBe(400);
		expect(await collections.customModels.countDocuments({})).toBe(0);
	});

	it("works for an anonymous session, keyed like settings", async () => {
		const locals = createTestLocals({ sessionId: "anon-session-1" });
		await created(locals);
		const row = await collections.customModels.findOne({});
		expect(row?.sessionId).toBe("anon-session-1");
		expect(row?.userId).toBeUndefined();

		const other = createTestLocals({ sessionId: "anon-session-2" });
		const listed = await testRequest(GET, { path: "/api/v2/custom-models", locals: other });
		expect(((await listed.json()) as { data: { models: unknown[] } }).data.models).toEqual([]);
	});
});

describe("GET /api/v2/custom-models", () => {
	it("lists the caller's own, by name", async () => {
		const { locals } = await createTestUser();
		await created(locals, { ...valid, name: "Zeta" });
		await created(locals, { ...valid, name: "Alpha" });
		const res = await testRequest(GET, { path: "/api/v2/custom-models", locals });
		const { data } = (await res.json()) as { data: { models: CustomModelView[] } };
		expect(data.models.map((m) => m.name)).toEqual(["Alpha", "Zeta"]);
	});
});

describe("privacy: another person's custom model does not exist", () => {
	it("hides it from the list and answers 404 to read, update and delete", async () => {
		const owner = await createTestUser();
		const stranger = await createTestUser();
		const model = await created(owner.locals);

		const list = await testRequest(GET, { path: "/api/v2/custom-models", locals: stranger.locals });
		expect(((await list.json()) as { data: { models: unknown[] } }).data.models).toEqual([]);

		expect((await one(stranger.locals, model.id, "GET")).status).toBe(404);
		expect((await one(stranger.locals, model.id, "PATCH", { name: "Mine now" })).status).toBe(404);
		expect((await one(stranger.locals, model.id, "DELETE")).status).toBe(404);

		const row = await collections.customModels.findOne({ userId: owner.user._id });
		expect(row?.name).toBe("Menu helper");
	});
});

describe("PATCH /api/v2/custom-models/[id]", () => {
	it("edits the prompt, the base and the description, and clears the description", async () => {
		const { locals } = await createTestUser();
		const model = await created(locals, { ...valid, description: "Lunch plans" });

		const res = await one(locals, model.id, "PATCH", {
			systemPrompt: "Plan dinners.",
			baseModelId: OTHER_BASE,
			description: null,
		});
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: CustomModelView };
		expect(data).toMatchObject({ systemPrompt: "Plan dinners.", baseModelId: OTHER_BASE });
		expect(data.description).toBeUndefined();
	});

	it("renames, refusing a name another of the caller's models already has", async () => {
		const { locals } = await createTestUser();
		await created(locals, { ...valid, name: "One" });
		const two = await created(locals, { ...valid, name: "Two" });

		expect((await one(locals, two.id, "PATCH", { name: "one" })).status).toBe(409);
		expect((await one(locals, two.id, "PATCH", { name: "Two!" })).status).toBe(200);
		// Re-saving its own name is not a clash.
		expect((await one(locals, two.id, "PATCH", { name: "Two!" })).status).toBe(200);
	});

	it("still lets a model whose base has left the catalogue be renamed or re-prompted", async () => {
		const { user, locals } = await createTestUser();
		const model = await created(locals);
		await collections.customModels.updateOne(
			{ userId: user._id },
			{ $set: { baseModelId: "gone/model" } }
		);
		expect((await one(locals, model.id, "PATCH", { systemPrompt: "New prompt." })).status).toBe(
			200
		);
		expect((await one(locals, model.id, "PATCH", { baseModelId: "gone/model" })).status).toBe(200);
		expect((await one(locals, model.id, "PATCH", { baseModelId: "also/gone" })).status).toBe(400);
	});
});

describe("DELETE /api/v2/custom-models/[id]", () => {
	it("removes it, and moves its chats and the default to the base model", async () => {
		const { user, locals } = await createTestUser();
		const model = await created(locals);
		const mine = new ObjectId();
		const elsewhere = new ObjectId();
		await collections.conversations.insertMany([
			{ _id: mine, userId: user._id, model: model.id, title: "t", messages: [] },
			{ _id: elsewhere, userId: user._id, model: OTHER_BASE, title: "t", messages: [] },
		] as never);
		await collections.settings.insertOne({
			_id: new ObjectId(),
			userId: user._id,
			activeModel: model.id,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const res = await one(locals, model.id, "DELETE");
		expect(res.status).toBe(204);

		expect(await collections.customModels.countDocuments({})).toBe(0);
		expect((await collections.conversations.findOne({ _id: mine }))?.model).toBe(BASE);
		expect((await collections.conversations.findOne({ _id: elsewhere }))?.model).toBe(OTHER_BASE);
		expect((await collections.settings.findOne({ userId: user._id }))?.activeModel).toBe(BASE);
	});
});

describe("a custom model as the default for new chats", () => {
	it("is kept by the settings endpoint when it is the caller's own, and reset when it is gone", async () => {
		const { user, locals } = await createTestUser();
		const model = await created(locals);
		await collections.settings.insertOne({
			_id: new ObjectId(),
			userId: user._id,
			activeModel: model.id,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const read = async () =>
			superjson.parse<{ activeModel: string }>(
				await (await testRequest(settingsGET, { path: "/api/v2/user/settings", locals })).text()
			).activeModel;

		expect(await read()).toBe(model.id);

		// Removed behind the app's back, so nothing moved the default.
		await collections.customModels.deleteMany({});
		expect(await read()).not.toBe(model.id);
		expect(await read()).toBe(BASE);
	});
});

describe("switching a conversation to and from a custom model", () => {
	async function conversationOn(
		locals: App.Locals,
		model: string,
		messages: Record<string, unknown>[] = []
	) {
		const id = new ObjectId();
		await collections.conversations.insertOne({
			_id: id,
			...(locals.user ? { userId: locals.user._id } : { sessionId: locals.sessionId }),
			model,
			title: "t",
			messages,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		return id;
	}

	const switchTo = (locals: App.Locals, id: ObjectId, model: string) =>
		testRequest(patchConversation, {
			path: `/api/v2/conversations/${id}`,
			params: { id: id.toString() },
			locals,
			...body("PATCH", { model }),
		});

	it("accepts the caller's own custom model, on both PATCH endpoints, and refuses anyone else's", async () => {
		const owner = await createTestUser();
		const stranger = await createTestUser();
		const model = await created(owner.locals);
		const conv = await conversationOn(owner.locals, BASE);

		expect((await switchTo(owner.locals, conv, model.id)).status).toBe(200);
		expect((await collections.conversations.findOne({ _id: conv }))?.model).toBe(model.id);

		const legacy = await patchConversationLegacy({
			locals: owner.locals,
			params: { id: conv.toString() },
			request: new Request("http://localhost/conversation/x", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: OTHER_BASE }),
			}),
		} as never);
		expect(legacy.status).toBe(200);
		expect((await collections.conversations.findOne({ _id: conv }))?.model).toBe(OTHER_BASE);

		const theirs = await conversationOn(stranger.locals, BASE);
		expect((await switchTo(stranger.locals, theirs, model.id)).status).toBe(400);
		expect((await collections.conversations.findOne({ _id: theirs }))?.model).toBe(BASE);
		expect((await switchTo(owner.locals, conv, "custom:ffffffffffffffffffffffff")).status).toBe(
			400
		);
	});

	it("stamps earlier replies with the BASE model that produced them, not the custom id", async () => {
		const { locals } = await createTestUser();
		const model = await created(locals);
		const conv = await conversationOn(locals, model.id, [
			{ id: "a", from: "assistant", content: "hi", children: [], ancestors: [] },
		]);

		expect((await switchTo(locals, conv, OTHER_BASE)).status).toBe(200);
		const stored = await collections.conversations.findOne({ _id: conv });
		expect(stored?.messages[0].routerMetadata?.model).toBe(BASE);
	});
});

describe("sharing a conversation on a custom model", () => {
	it("stores the base model on the link, never the custom id", async () => {
		const { locals } = await createTestUser();
		const model = await created(locals, { ...valid, systemPrompt: "SECRET CUSTOM PROMPT" });
		const id = new ObjectId();
		await collections.conversations.insertOne({
			_id: id,
			userId: locals.user?._id,
			model: model.id,
			title: "t",
			messages: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const res = await shareConversation({ locals, params: { id: id.toString() } } as never);
		expect(res.status).toBe(200);
		const { shareId } = (await res.json()) as { shareId: string };
		const shared = await collections.sharedConversations.findOne({ _id: shareId });
		expect(shared?.model).toBe(BASE);
		expect(JSON.stringify(shared)).not.toContain("SECRET CUSTOM PROMPT");
		expect(JSON.stringify(shared)).not.toContain("custom:");
	});
});
