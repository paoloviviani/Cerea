/**
 * The past-chats embedder chosen when a project is created: the create route
 * checks it as the past-chats POST does, stores it, and the first indexed chat
 * makes the base with it. The gateway's catalogue and the store are stubbed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const gatewayGet = vi.hoisted(() =>
	vi.fn(async (..._args: unknown[]) => ({
		data: [
			{ id: "default-embed", kind: "embedding" },
			{ id: "other-embed", kind: "embedding" },
		],
	}))
);
vi.mock("$lib/server/gatewayServer", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/gatewayServer")>()),
	gateway: { get: gatewayGet },
}));

const createStore = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ id: "" })));
const addText = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("$lib/server/knowledge/service", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/knowledge/service")>()),
	createStore,
	addText,
}));

import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { indexConversation } from "$lib/server/projects";
import { POST } from "./+server";
import { GET as MODELS } from "./past-chats-models/+server";

beforeAll(async () => {
	await ready;
}, 30000);

beforeEach(async () => {
	await collections.knowledgeConfig.updateOne(
		{},
		{ $set: { embeddingModel: "default-embed" } },
		{ upsert: true }
	);
	createStore.mockClear();
	addText.mockClear();
});

afterEach(async () => {
	await cleanupTestData();
	await collections.projects.deleteMany({});
	await collections.vectorStores.deleteMany({});
	await collections.knowledgeConfig.deleteMany({});
});

async function create(body: Record<string, unknown>) {
	const user = await createTestUser();
	const locals = { ...user.locals, token: "tok" };
	const res = await testRequest(POST, {
		path: "/api/v2/projects",
		method: "POST",
		locals,
		body: JSON.stringify({ name: "P", ...body }),
		headers: { "content-type": "application/json" },
	});
	return { res, user, locals };
}

describe("past-chats embedder on create", () => {
	it("offers the models the user may use, with the deployment default", async () => {
		const user = await createTestUser();
		const res = await testRequest(MODELS, {
			path: "/api/v2/projects/past-chats-models",
			locals: { ...user.locals, token: "tok" },
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { data: unknown }).data).toEqual({
			models: ["default-embed", "other-embed"],
			defaultModel: "default-embed",
		});
	});

	it("stores a model the creator may use", async () => {
		const { res } = await create({ indexPastChats: true, pastChatsEmbeddingModel: "other-embed" });
		expect(res.status).toBe(201);
		const stored = await collections.projects.findOne({});
		expect(stored?.pastChatsEmbeddingModel).toBe("other-embed");
	});

	it("treats empty and the deployment default as no choice", async () => {
		for (const model of ["", "default-embed"]) {
			const { res } = await create({ indexPastChats: true, pastChatsEmbeddingModel: model });
			expect(res.status).toBe(201);
		}
		const all = await collections.projects.find({}).toArray();
		expect(all).toHaveLength(2);
		expect(all.every((p) => p.pastChatsEmbeddingModel === undefined)).toBe(true);
	});

	it("rejects a model the creator may not use", async () => {
		const { res } = await create({ indexPastChats: true, pastChatsEmbeddingModel: "secret-embed" });
		expect(res.status).toBe(400);
		expect(await collections.projects.countDocuments({})).toBe(0);
	});

	it("makes the past-chats base with the chosen model on the first indexed chat", async () => {
		const { res, user, locals } = await create({
			indexPastChats: true,
			pastChatsEmbeddingModel: "other-embed",
		});
		const view = (await res.json()) as { id: string };
		const project = await collections.projects.findOne({ _id: new ObjectId(view.id) });
		if (!project) throw new Error("project missing");
		const storeId = new ObjectId();
		createStore.mockImplementationOnce(async () => {
			await collections.vectorStores.insertOne({
				_id: storeId,
				ownerId: project.userId,
				shares: [],
			} as never);
			return { id: storeId.toString() };
		});
		const conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId: user.user._id,
			title: "t",
			messages: [],
		} as never);
		await indexConversation({
			project,
			conversation: { _id: conversationId, title: "t" } as never,
			messages: [
				{ from: "user", content: "What is the plan for the quarterly budget review?" },
				{ from: "assistant", content: "The plan is to review the quarterly budget in March." },
			] as never,
			token: "tok",
			locals: locals as never,
		});
		expect(createStore).toHaveBeenCalledTimes(1);
		expect(createStore.mock.calls[0][1]).toMatchObject({ embedding_model: "other-embed" });
		expect(createStore.mock.calls[0][2]).toBe("tok");
	});
});
