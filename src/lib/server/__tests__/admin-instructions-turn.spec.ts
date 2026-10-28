/**
 * The administrator's instructions, end to end: what a chat turn sends
 * upstream, which paths carry them, and what Settings is told.
 *
 * The real route, generation pipeline and Mongo; only the OpenAI-compatible
 * upstream is scripted, as in `custom-models-turn.spec.ts`. The config is the
 * real one with the two admin keys answered from a stand-in, because the
 * config manager is switched off under test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import superjson from "superjson";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import type { Conversation } from "$lib/types/Conversation";
import { streamFor } from "$lib/server/textGeneration/__tests__/replayHarness";
import { testRequest } from "$lib/server/__tests__/testRequest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	admin: { text: "", visible: "" },
}));

vi.mock("openai", async (importOriginal) => ({
	...(await importOriginal<typeof import("openai")>()),
	OpenAI: class {
		chat = { completions: { create: mocks.create } };
	},
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));
vi.mock("$lib/server/config", async (importOriginal) => {
	const real = await importOriginal<typeof import("$lib/server/config")>();
	return {
		...real,
		config: new Proxy(real.config, {
			get(target, key) {
				if (key === "ADMIN_INSTRUCTIONS") return mocks.admin.text;
				if (key === "ADMIN_INSTRUCTIONS_VISIBLE") return mocks.admin.visible;
				return (target as never)[key];
			},
		}),
	};
});

const { POST } = await import("../../../routes/conversation/[id]/+server");
const { GET: settingsGET } = await import("../../../routes/api/v2/user/settings/+server");
const { textGeneration } = await import("$lib/server/textGeneration");
const { generateFromDefaultEndpoint } = await import("$lib/server/generateFromDefaultEndpoint");
const { models } = await import("$lib/server/models");

const { ADMIN_INSTRUCTIONS_OPEN, ADMIN_INSTRUCTIONS_CLOSE } =
	await import("$lib/server/adminInstructions");
const blockOf = (text: string) =>
	`${ADMIN_INSTRUCTIONS_OPEN}\n${text}\n${ADMIN_INSTRUCTIONS_CLOSE}`;

const DEFAULT_MODEL = "test-org/test-model";

beforeAll(async () => {
	await ready;
});

beforeEach(() => {
	mocks.create.mockReset();
	mocks.create.mockImplementation(async () => streamFor({ content: "ok" }));
	mocks.admin.text = "";
	mocks.admin.visible = "";
});

afterEach(async () => {
	await cleanupTestData();
});

interface Sent {
	messages: { role: string; content: unknown }[];
}
const sent = (n = 0) => mocks.create.mock.calls[n][0] as Sent;
const systemOf = (request: Sent) =>
	String(request.messages.find((m) => m.role === "system")?.content ?? "");

async function setup(global?: string) {
	const { user, locals } = await createTestUser();
	await collections.settings.insertOne({
		_id: new ObjectId(),
		userId: user._id,
		...(global ? { globalSystemPrompt: global } : {}),
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	const rootId = crypto.randomUUID();
	const conv = await createTestConversation(locals, {
		model: DEFAULT_MODEL,
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
	});
	return { conv, locals };
}

async function send(conv: Conversation, locals: App.Locals) {
	const form = new FormData();
	form.set("data", JSON.stringify({ inputs: "hello", id: conv.messages.at(-1)?.id }));
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

describe.sequential("a chat turn", () => {
	it("starts its system prompt with the administrator's instructions, then the person's global prompt", async () => {
		mocks.admin.text = "  ADMIN RULES  ";
		const { conv, locals } = await setup("GLOBAL PROMPT");
		await send(conv, locals);

		const system = systemOf(sent());
		// The fixed label and closing line, written out so a change to them is noticed.
		expect(
			system.startsWith("Instructions from this deployment's administrator:\nADMIN RULES\n")
		).toBe(true);
		expect(system).toContain("\nEnd of the administrator's instructions.\n\n");
		// Delimited, trimmed, and literally first, tool contract included.
		expect(system.startsWith(`${blockOf("ADMIN RULES")}\n\n`)).toBe(true);
		// On a tool turn the tool contract sits between the block and the
		// person's prompt: the block is before both.
		expect(system.indexOf("GLOBAL PROMPT")).toBeGreaterThan(
			system.indexOf(ADMIN_INSTRUCTIONS_CLOSE)
		);
		expect(system).toContain("Do NOT call a tool unless");
		expect(system.split("ADMIN RULES")).toHaveLength(2);
	});

	it("carries nothing of it when it is empty", async () => {
		const { conv, locals } = await setup("GLOBAL PROMPT");
		await send(conv, locals);
		expect(systemOf(sent())).toContain("GLOBAL PROMPT");
		expect(JSON.stringify(sent())).not.toContain("ADMIN RULES");
	});

	it("carries it even when the administrator hid it from people", async () => {
		mocks.admin.text = "ADMIN RULES";
		mocks.admin.visible = "false";
		const { conv, locals } = await setup();
		await send(conv, locals);
		expect(systemOf(sent())).toContain("ADMIN RULES");
	});

	it("carries it on a resumed turn, which the sweepers run through the same pipeline with no request", async () => {
		const { conv, locals } = await setup("GLOBAL PROMPT");
		await send(conv, locals);
		mocks.create.mockClear();

		mocks.admin.text = "ADMIN RULES";
		const stored = (await collections.conversations.findOne({ _id: conv._id })) as Conversation;
		const model = models.find((m) => m.id === DEFAULT_MODEL);
		if (!model) throw new Error("fixture model missing");
		const abortController = new AbortController();
		const events = textGeneration({
			model,
			endpoint: await model.getEndpoint(),
			conv: stored,
			messages: stored.messages.filter((m) => m.from !== "assistant"),
			promptedAt: new Date(),
			ip: "sweeper",
			locals,
			abortController,
			generationId: crypto.randomUUID(),
			messageId: stored.messages.find((m) => m.from === "assistant")?.id,
		});
		for await (const _event of events) void _event;

		expect(mocks.create).toHaveBeenCalled();
		const system = systemOf(sent());
		expect(system.startsWith(blockOf("ADMIN RULES"))).toBe(true);
		expect(system.indexOf("GLOBAL PROMPT")).toBeGreaterThan(
			system.indexOf(ADMIN_INSTRUCTIONS_CLOSE)
		);
	});
});

describe.sequential("what is not a chat turn", () => {
	it("title generation's completion does not carry it", async () => {
		mocks.admin.text = "ADMIN RULES";
		for await (const _update of generateFromDefaultEndpoint({
			messages: [{ from: "user", content: "name this" }],
			preprompt: "TITLE PROMPT",
			locals: undefined,
		}))
			void _update;
		expect(mocks.create).toHaveBeenCalled();
		expect(systemOf(sent())).toBe("TITLE PROMPT");
		expect(JSON.stringify(sent())).not.toContain("ADMIN RULES");
	});

	it("is read by the chat pipeline and sub-agents only: the /code panel, galopin and titles never touch it", () => {
		const root = join(__dirname, "../../../..");
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) {
					if (name !== "node_modules") walk(path);
				} else if (/\.(ts|svelte|go)$/.test(name) && !/\.(spec|test)\./.test(name)) {
					files.push(path);
				}
			}
		};
		walk(join(root, "src"));
		walk(join(root, "agent"));
		const users = files
			.filter((file) => /adminInstructions|ADMIN_INSTRUCTIONS/.test(readFileSync(file, "utf8")))
			.map((file) => file.slice(root.length + 1))
			.sort();
		expect(users).toEqual([
			"src/lib/components/models/CustomModelsManager.svelte",
			"src/lib/server/adminInstructions.ts",
			"src/lib/server/textGeneration/builtinTools/nestedAgent.ts",
			"src/lib/server/textGeneration/index.ts",
			"src/lib/server/textGeneration/mcp/runMcpFlow.ts",
			"src/lib/server/textGeneration/preprompt.ts",
			"src/lib/stores/settings.ts",
			"src/routes/admin/instructions/+page.svelte",
			"src/routes/api/v2/admin/instructions/+server.ts",
			"src/routes/api/v2/user/settings/+server.ts",
		]);
	});
});

describe.sequential("what Settings is told", () => {
	const settingsFor = async () => {
		const { locals } = await createTestUser();
		const res = await testRequest(settingsGET, { path: "/api/v2/user/settings", locals });
		return superjson.parse(await res.text()) as Record<string, unknown>;
	};

	it("includes the text while the administrator shows it, which is the default", async () => {
		mocks.admin.text = "ADMIN RULES";
		expect((await settingsFor()).adminInstructions).toBe("ADMIN RULES");
		mocks.admin.visible = "true";
		expect((await settingsFor()).adminInstructions).toBe("ADMIN RULES");
	});

	it("carries neither the text nor the field when hidden", async () => {
		mocks.admin.text = "ADMIN RULES";
		mocks.admin.visible = "false";
		const data = await settingsFor();
		expect(data).not.toHaveProperty("adminInstructions");
		expect(JSON.stringify(data)).not.toContain("ADMIN RULES");
	});

	it("has no field at all when there are no instructions", async () => {
		expect(await settingsFor()).not.toHaveProperty("adminInstructions");
	});
});
