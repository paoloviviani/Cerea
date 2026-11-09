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

	async function firstTurn(speaker: "owner" | "member", beforeTurn?: () => void) {
		const { res, user, locals } = await create({
			indexPastChats: true,
			pastChatsEmbeddingModel: "other-embed",
		});
		const view = (await res.json()) as { id: string };
		const project = await collections.projects.findOne({ _id: new ObjectId(view.id) });
		if (!project) throw new Error("project missing");
		const member = await createTestUser();
		const who = speaker === "owner" ? { user, locals } : { user: member, locals: member.locals };
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
			userId: who.user.user._id,
			title: "t",
			messages: [],
		} as never);
		beforeTurn?.();
		await indexConversation({
			project,
			conversation: { _id: conversationId, title: "t" } as never,
			messages: [
				{ from: "user", content: "What is the plan for the quarterly budget review?" },
				{ from: "assistant", content: "The plan is to review the quarterly budget in March." },
			] as never,
			token: "tok",
			locals: { ...who.locals, token: "tok" } as never,
		});
		return { project, stored: await collections.projects.findOne({ _id: project._id }) };
	}

	it("makes the base with the chosen model on the owner's first indexed chat, then forgets the choice", async () => {
		const { project, stored } = await firstTurn("owner");
		expect(createStore).toHaveBeenCalledTimes(1);
		expect(createStore.mock.calls[0][1]).toMatchObject({ embedding_model: "other-embed" });
		expect(createStore.mock.calls[0][2]).toBe("tok");
		expect(stored?.memoryBaseId).toBeDefined();
		expect(stored?.pastChatsEmbeddingModel).toBeUndefined();
		expect(project.pastChatsEmbeddingModel).toBe("other-embed");
	});

	it("makes the base with the stored model on a member's first turn when the member may use it, embedding as the member", async () => {
		const { stored } = await firstTurn("member");
		expect(createStore).toHaveBeenCalledTimes(1);
		expect(createStore.mock.calls[0][1]).toMatchObject({ embedding_model: "other-embed" });
		expect(createStore.mock.calls[0][2]).toBe("tok");
		expect(stored?.memoryBaseId).toBeDefined();
		expect(stored?.pastChatsEmbeddingModel).toBeUndefined();
	});

	it("falls back to the default on a member's first turn when neither the owner nor the member can be shown to have the model", async () => {
		const { stored } = await firstTurn("member", () =>
			gatewayGet.mockResolvedValueOnce({ data: [{ id: "default-embed", kind: "embedding" }] })
		);
		expect(createStore).toHaveBeenCalledTimes(1);
		expect(createStore.mock.calls[0][1]).not.toHaveProperty("embedding_model", "other-embed");
		expect(stored?.memoryBaseId).toBeDefined();
		expect(stored?.pastChatsEmbeddingModel).toBeUndefined();
	});

	it("falls back to the default and clears the choice when the owner lost access", async () => {
		const { stored } = await firstTurn("owner", () =>
			gatewayGet.mockResolvedValueOnce({ data: [{ id: "default-embed", kind: "embedding" }] })
		);
		expect(createStore).toHaveBeenCalledTimes(1);
		expect(createStore.mock.calls[0][1]).not.toHaveProperty("embedding_model", "other-embed");
		expect(stored?.memoryBaseId).toBeDefined();
		expect(stored?.pastChatsEmbeddingModel).toBeUndefined();
	});

	it("does not let a request body skip the model check (the gateway route passes it to createStore)", async () => {
		const { createStore: realCreateStore } = await vi.importActual<
			typeof import("$lib/server/knowledge/service")
		>("$lib/server/knowledge/service");
		const user = await createTestUser();
		const caller = { userId: user.user._id, email: null, groups: [], isAdmin: false };
		await expect(
			realCreateStore(
				caller,
				{ name: "x", embedding_model: "secret-embed", embedding_trusted: true } as never,
				"tok"
			)
		).rejects.toMatchObject({ status: 400 });
	});

	it("rejects the models list without a user", async () => {
		const res = await testRequest(MODELS, {
			path: "/api/v2/projects/past-chats-models",
			locals: { user: undefined, token: undefined },
		});
		expect(res.status).toBe(401);
	});
});
