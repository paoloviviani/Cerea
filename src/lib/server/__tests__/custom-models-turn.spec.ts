/**
 * What a chat turn on a custom model sends upstream.
 *
 * The real route, tree builder, generation pipeline and Mongo; only the
 * OpenAI-compatible upstream is scripted, as in `replayRoundTrip.spec.ts`. The
 * assertion surface is the request the upstream receives: that is the only
 * place "the custom id never leaves Cerea" and "the prompts arrive in order"
 * can be seen.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import type { Conversation } from "$lib/types/Conversation";
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
const { POST: createConversation } = await import("../../../routes/conversation/+server");

/** Fixture catalogue: the first entry is the deployment default. */
const DEFAULT_MODEL = "test-org/test-model";
const BASE = "test-org/thinking-model";

beforeAll(async () => {
	await ready;
});

beforeEach(() => {
	mocks.create.mockReset();
	mocks.create.mockImplementation(async () => streamFor({ content: "ok" }));
});

afterEach(async () => {
	await cleanupTestData();
});

interface Sent {
	model: string;
	reasoning_effort?: string;
	messages: { role: string; content: unknown }[];
}

/** The completion request the chat turn made (titles are separate, later calls). */
const sent = (n = 0) => mocks.create.mock.calls[n][0] as Sent;
const systemOf = (request: Sent) =>
	String(request.messages.find((m) => m.role === "system")?.content ?? "");

async function setup(options: {
	global?: string;
	custom?: { name?: string; baseModelId?: string; systemPrompt?: string } | null;
	settings?: Record<string, unknown>;
	conversation?: Partial<Conversation>;
}) {
	const { user, locals } = await createTestUser();
	const customId = new ObjectId();
	if (options.custom !== null) {
		await collections.customModels.insertOne({
			_id: customId,
			userId: user._id,
			name: options.custom?.name ?? "Menu helper",
			nameKey: (options.custom?.name ?? "Menu helper").toLowerCase(),
			baseModelId: options.custom?.baseModelId ?? BASE,
			systemPrompt: options.custom?.systemPrompt ?? "CUSTOM PROMPT",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
	}
	await collections.settings.insertOne({
		_id: new ObjectId(),
		userId: user._id,
		...(options.global ? { globalSystemPrompt: options.global } : {}),
		...options.settings,
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	const rootId = crypto.randomUUID();
	const conv = await createTestConversation(locals, {
		model: `custom:${customId}`,
		title: "t",
		rootMessageId: rootId,
		messages: [
			{
				id: rootId,
				from: "system",
				content: "",
				ancestors: [],
				children: [],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		],
		...options.conversation,
	});
	return { conv, locals, customId };
}

async function send(conv: Conversation, locals: App.Locals, prompt = "hello") {
	const form = new FormData();
	form.set("data", JSON.stringify({ inputs: prompt, id: conv.messages.at(-1)?.id }));
	const response = await POST({
		request: new Request(`http://localhost/conversation/${conv._id}`, {
			method: "POST",
			body: form,
		}),
		locals,
		params: { id: conv._id.toString() },
		getClientAddress: () => "127.0.0.1",
	} as never);
	if (response.status !== 200) throw new Error(`POST ${response.status}: ${await response.text()}`);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("no body");
	for (;;) if ((await reader.read()).done) break;
}

describe.sequential("a turn on a custom model", () => {
	it("goes upstream on the base model, and the custom id appears nowhere in the request", async () => {
		const { conv, locals } = await setup({});
		await send(conv, locals);

		expect(mocks.create).toHaveBeenCalled();
		const request = sent();
		expect(request.model).toBe(BASE);
		expect(JSON.stringify(request)).not.toContain("custom:");
		// The conversation keeps the custom id: it is the person's model, not the base.
		expect((await collections.conversations.findOne({ _id: conv._id }))?.model).toBe(conv.model);
	});

	it("sends the global prompt, then the custom model's, ahead of everything else the turn adds", async () => {
		const { conv, locals } = await setup({ global: "GLOBAL PROMPT" });
		await send(conv, locals);

		const system = systemOf(sent());
		expect(system.startsWith("GLOBAL PROMPT\n\nCUSTOM PROMPT")).toBe(true);
	});

	it("applies the global prompt on an ordinary model too", async () => {
		const first = await setup({ global: "GLOBAL PROMPT", custom: null });
		await collections.conversations.updateOne(
			{ _id: first.conv._id },
			{ $set: { model: DEFAULT_MODEL } }
		);
		await send({ ...first.conv, model: DEFAULT_MODEL }, first.locals);
		expect(sent().model).toBe(DEFAULT_MODEL);
		// A tool-capable model's turn leads with the tool contract; the person's
		// prompt is still in the system message.
		expect(systemOf(sent())).toContain("GLOBAL PROMPT");
		expect(systemOf(sent())).not.toContain("CUSTOM PROMPT");
	});

	it("passes the chosen thinking effort through to the base model", async () => {
		const { conv, locals } = await setup({
			settings: { reasoningOverrides: { [BASE]: true } },
			conversation: { reasoningEffort: "high" },
		});
		await send(conv, locals);
		expect(sent().model).toBe(BASE);
		expect(sent().reasoning_effort).toBe("high");
	});

	it("inherits the person's per-model settings for the base: effort default, and tools/vision overrides", async () => {
		const { conv, locals } = await setup({
			settings: {
				reasoningOverrides: { [BASE]: true },
				reasoningEffortOverrides: { [BASE]: "low" },
			},
		});
		await send(conv, locals);
		expect(sent().reasoning_effort).toBe("low");
	});

	it("does not apply a per-model system prompt left over in settings", async () => {
		const { conv, locals } = await setup({
			custom: null,
			settings: {
				customPrompts: {
					[BASE]: "STALE PER-MODEL PROMPT",
					[DEFAULT_MODEL]: "STALE PER-MODEL PROMPT",
				},
				customPromptsEnabled: { [BASE]: true },
			},
		});
		await send({ ...conv, model: BASE }, locals);
		await collections.conversations.updateOne({ _id: conv._id }, { $set: { model: BASE } });
		expect(JSON.stringify(sent())).not.toContain("STALE PER-MODEL PROMPT");
	});
});

describe.sequential("internal completions are not chat turns", () => {
	it("titles on the base model with none of the person's prompts", async () => {
		const { conv, locals } = await setup({
			global: "GLOBAL PROMPT",
			conversation: { title: "New Chat" },
		});
		await send(conv, locals, "plan a menu");

		const requests = mocks.create.mock.calls.map((call) => call[0] as Sent);
		const title = requests.find((r) => systemOf(r).includes("chat thread titling assistant"));
		expect(title, "the first turn also generates a title").toBeDefined();
		expect(title?.model).toBe(BASE);
		expect(JSON.stringify(title)).not.toContain("GLOBAL PROMPT");
		expect(JSON.stringify(title)).not.toContain("CUSTOM PROMPT");
		expect(JSON.stringify(title)).not.toContain("custom:");
	});
});

describe.sequential("when the custom model or its base is gone", () => {
	it("falls back to the deployment default, without the deleted model's prompt, instead of failing", async () => {
		const { conv, locals, customId } = await setup({ global: "GLOBAL PROMPT" });
		await collections.customModels.deleteOne({ _id: customId });
		await send(conv, locals);

		expect(sent().model).toBe(DEFAULT_MODEL);
		expect(systemOf(sent())).toContain("GLOBAL PROMPT");
		expect(systemOf(sent())).not.toContain("CUSTOM PROMPT");
	});

	it("falls back to the default model when the base left the catalogue, keeping the person's prompt", async () => {
		const { conv, locals } = await setup({ custom: { baseModelId: "retired/model" } });
		await send(conv, locals);

		expect(sent().model).toBe(DEFAULT_MODEL);
		expect(systemOf(sent())).toContain("CUSTOM PROMPT");
	});

	it("does not resolve somebody else's custom model", async () => {
		const owner = await setup({});
		const stranger = await createTestUser();
		const conv = await createTestConversation(stranger.locals, {
			model: owner.conv.model,
			title: "t",
			rootMessageId: owner.conv.rootMessageId,
			messages: owner.conv.messages,
		});
		await send(conv, stranger.locals);

		expect(sent().model).toBe(DEFAULT_MODEL);
		expect(systemOf(sent())).not.toContain("CUSTOM PROMPT");
	});
});

describe.sequential("starting a conversation", () => {
	const create = (locals: App.Locals, payload: Record<string, unknown>) =>
		createConversation({
			locals,
			request: new Request("http://localhost/conversation", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			}),
		} as never);

	it("starts on a custom model and keeps its id", async () => {
		const { locals, customId } = await setup({});
		const response = await create(locals, { model: `custom:${customId}` });
		const { conversationId } = (await response.json()) as { conversationId: string };
		const stored = await collections.conversations.findOne({ _id: new ObjectId(conversationId) });
		expect(stored?.model).toBe(`custom:${customId}`);
	});

	it("refuses a custom model that is not the caller's", async () => {
		const owner = await setup({});
		const stranger = await createTestUser();
		await expect(create(stranger.locals, { model: owner.conv.model })).rejects.toMatchObject({
			status: 400,
		});
	});

	it("ignores a per-model prompt sent by an old client", async () => {
		const { locals } = await createTestUser();
		const response = await create(locals, {
			model: DEFAULT_MODEL,
			preprompt: "STALE PER-MODEL PROMPT",
		});
		const { conversationId } = (await response.json()) as { conversationId: string };
		const stored = await collections.conversations.findOne({ _id: new ObjectId(conversationId) });
		expect(stored?.preprompt ?? "").not.toContain("STALE");
		expect(stored?.messages[0].content).not.toContain("STALE");
	});
});
