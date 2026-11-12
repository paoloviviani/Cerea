import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { MessageUpdate } from "$lib/types/MessageUpdate";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import { FakeBrowserRuntime, type FakePage } from "$lib/server/browser/fakeRuntime";
import {
	answerTurn,
	callTurn,
	scriptedModel,
	type ScriptedTurn,
} from "$lib/server/browser/fakeModel";
import type { BrowserSettings } from "$lib/server/browser/settings";
import { FAKE_BROWSER_KEY } from "$lib/server/browser/fakeRuntime";
import { memoryLeaseStore, type LeaseStore } from "$lib/server/browser/lease";
import type { NestedAgentDeps } from "./nestedAgent";

const saveBrowserDownloads = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/browser/downloads", () => ({ saveBrowserDownloads }));

import { BROWSE_TOOL_NAME, createBrowseTool, openAiComplete } from "./browseTool";
import { getEnabledBuiltinTools } from "./index";
import { SUBAGENT_BUILTIN_TOOLS } from "./delegateTool";

const pages = (): FakePage[] => [
	{
		id: "cart",
		url: "https://shop.example.com/cart",
		title: "Your cart",
		elements: [
			{ ref: "e1", role: "button", name: "Pay €120", onClick: { goto: "done" } },
			{
				ref: "e2",
				role: "link",
				name: "invoice.pdf",
				download: true,
				onClick: { download: { name: "invoice.pdf", mime: "application/pdf", content: "%PDF" } },
			},
		],
		extract: { tables: [{ headers: ["Total"], rows: [["120"]] }], lists: [] },
	},
	{ id: "done", url: "https://shop.example.com/done", title: "Done", elements: [] },
];

const settings = (over: Partial<BrowserSettings> = {}): BrowserSettings => ({
	enabled: true,
	model: "",
	budgets: { maxSteps: 10, maxTokens: 100_000, maxSeconds: 300 },
	rules: { allow: [], deny: [] },
	...over,
});

const laptop = { id: "a".repeat(24), name: "Laptop" };
const desk = { id: "b".repeat(24), name: "Desk" };
const turnDeps = { completionBase: { model: "chat-model" } } as unknown as NestedAgentDeps;

function build(options: {
	script: ScriptedTurn[];
	machines?: (typeof laptop)[];
	settings?: BrowserSettings;
	approve?: "approved" | "denied";
	runtime?: FakeBrowserRuntime;
	leases?: LeaseStore;
}) {
	const runtime = options.runtime ?? new FakeBrowserRuntime(pages());
	const model = scriptedModel(options.script);
	const models: string[] = [];
	const asks: string[] = [];
	const tool = createBrowseTool({
		machines: options.machines ?? [laptop],
		settings: options.settings ?? settings(),
		ceiling: "ask",
		userId: new ObjectId(),
		runtimeFor: () => runtime,
		grantKeyFor: async () => FAKE_BROWSER_KEY,
		leases: options.leases ?? memoryLeaseStore(),
		approver: async (ask) => {
			asks.push(ask.sentence);
			return options.approve === "denied"
				? { verdict: "denied" }
				: { verdict: "approved", id: "a1" };
		},
		completeFor: (_deps, modelId) => {
			models.push(modelId);
			return model.complete;
		},
	});
	tool.bind(turnDeps);
	const updates: MessageUpdate[] = [];
	const ctx = {
		uuid: "call-uuid",
		toolCallId: "call-1",
		elicitationSink: {
			conversationId: new ObjectId(),
			emit: (u: MessageUpdate) => void updates.push(u),
		},
	};
	return { tool, runtime, model, models, asks, updates, ctx };
}

const browseUpdates = (updates: MessageUpdate[]) =>
	updates.filter((u) => u.type === MessageUpdateType.Browse) as Extract<
		MessageUpdate,
		{ type: MessageUpdateType.Browse }
	>[];

beforeEach(() => saveBrowserDownloads.mockReset());

describe("browse: the chat model's tool", () => {
	it("returns the ADR's result shape as the tool result", async () => {
		const t = build({
			script: [
				callTurn("extract", {}),
				answerTurn("The cart total is €120."),
				answerTurn('{"total":120}'),
			],
		});
		const out = await t.tool.execute(
			{
				goal: "read the cart total",
				start_url: "https://shop.example.com/cart",
				output_schema: { type: "object" },
			},
			t.ctx
		);
		expect("resultText" in out).toBe(true);
		const body = JSON.parse((out as { resultText: string }).resultText);
		expect(body).toEqual({
			result: "The cart total is €120.",
			data: { total: 120 },
			final_url: "https://shop.example.com/cart",
			steps: 1,
		});
	});

	it("streams a card that ends done, with the steps it took", async () => {
		const t = build({ script: [callTurn("snapshot", {}), answerTurn("looked")] });
		await t.tool.execute({ goal: "look at the cart" }, t.ctx);
		const cards = browseUpdates(t.updates);
		expect(cards.length).toBeGreaterThan(2);
		expect(cards[0]).toMatchObject({
			uuid: "call-uuid",
			status: "running",
			goal: "look at the cart",
		});
		const last = cards.at(-1);
		expect(last).toMatchObject({ status: "done", model: "chat-model" });
		expect(last?.steps.map((s) => s.action)).toContain("Look at the page");
		expect(last?.activity).toBeUndefined();
	});

	it("shows the card waiting while an approval is open, then carries on", async () => {
		const t = build({
			script: [callTurn("act", { actions: [{ type: "click", ref: "e1" }] }), answerTurn("paid")],
		});
		let waitingSeen = false;
		const emit = t.ctx.elicitationSink.emit;
		t.ctx.elicitationSink.emit = (u) => {
			emit(u);
			if (u.type === MessageUpdateType.Browse && u.status === "waiting") waitingSeen = true;
		};
		await t.tool.execute({ goal: "pay" }, t.ctx);
		// The test approver answers at once, so the card is waiting only if the loop said so.
		expect(t.asks).toEqual(['Click "Pay €120" on shop.example.com']);
		expect(waitingSeen).toBe(true);
		expect(browseUpdates(t.updates).at(-1)?.status).toBe("done");
	});

	it("ends the card stopped, with the reason, when a budget runs out", async () => {
		const t = build({
			script: [
				callTurn("snapshot", {}),
				callTurn("snapshot", {}),
				(req) => (req.tools ? callTurn("snapshot", {}) : answerTurn("partial")),
			],
			settings: settings({ budgets: { maxSteps: 2, maxTokens: 100_000, maxSeconds: 300 } }),
		});
		const out = await t.tool.execute({ goal: "look" }, t.ctx);
		const body = JSON.parse((out as { resultText: string }).resultText);
		expect(body).toMatchObject({ result: "partial", stopped_reason: "max_steps", steps: 2 });
		expect(browseUpdates(t.updates).at(-1)).toMatchObject({
			status: "stopped",
			stoppedReason: "max_steps",
		});
	});

	it("runs on the browser model when one is set, else the chat's", async () => {
		const own = build({
			script: [answerTurn("ok")],
			settings: settings({ model: "browser-model" }),
		});
		await own.tool.execute({ goal: "look" }, own.ctx);
		expect(own.models).toEqual(["browser-model"]);
		expect(browseUpdates(own.updates).at(-1)?.model).toBe("browser-model");

		const fallback = build({ script: [answerTurn("ok")] });
		await fallback.tool.execute({ goal: "look" }, fallback.ctx);
		expect(fallback.models).toEqual(["chat-model"]);
	});

	it("keeps downloads in the conversation through the store", async () => {
		saveBrowserDownloads.mockResolvedValue([
			{
				name: "invoice.pdf",
				size: 4,
				saved: true,
				note: "[file saved to this conversation: invoice.pdf]",
			},
		]);
		const t = build({
			script: [
				callTurn("act", { actions: [{ type: "click", ref: "e2" }] }),
				callTurn("download", {}),
				answerTurn("got it"),
			],
		});
		const conversationId = new ObjectId();
		const out = await t.tool.execute(
			{ goal: "get the invoice" },
			{ ...t.ctx, conversationId, messageId: "m1" }
		);
		expect(saveBrowserDownloads).toHaveBeenCalledWith(
			[expect.objectContaining({ name: "invoice.pdf" })],
			expect.objectContaining({ conversationId, emitFile: expect.any(Function) })
		);
		expect(JSON.parse((out as { resultText: string }).resultText).files[0]).toMatchObject({
			name: "invoice.pdf",
			saved: true,
		});
	});

	it("names a refusal in the result so the chat model does not try another way", async () => {
		const t = build({
			script: [
				callTurn("act", { actions: [{ type: "click", ref: "e1" }] }),
				answerTurn("The user did not allow the payment."),
			],
			approve: "denied",
		});
		const out = await t.tool.execute({ goal: "pay" }, t.ctx);
		expect(JSON.parse((out as { resultText: string }).resultText).result).toContain(
			"did not allow"
		);
		expect(t.runtime.performed).toEqual([]);
	});
});

describe("browse: arguments and machines", () => {
	it("needs a goal", async () => {
		const t = build({ script: [answerTurn("x")] });
		expect(await t.tool.execute({}, t.ctx)).toEqual({
			error: expect.stringContaining("needs a `goal`"),
		});
		expect(await t.tool.execute({ goal: "x".repeat(5000) }, t.ctx)).toEqual({
			error: expect.stringContaining("too long"),
		});
	});

	it("accepts only an http or https start URL", async () => {
		const t = build({ script: [answerTurn("x")] });
		expect(
			await t.tool.execute({ goal: "open it", start_url: "file:///etc/passwd" }, t.ctx)
		).toEqual({ error: expect.stringContaining("http or https") });
		expect(
			await t.tool.execute({ goal: "open it", start_url: "javascript:alert(1)" }, t.ctx)
		).toEqual({ error: expect.stringContaining("http or https") });
	});

	it("rejects an output schema that is not an object", async () => {
		const t = build({ script: [answerTurn("x")] });
		expect(await t.tool.execute({ goal: "list them", output_schema: "string" }, t.ctx)).toEqual({
			error: expect.stringContaining("JSON Schema object"),
		});
	});

	it("picks a machine by name, and says which exist when the name is wrong", async () => {
		const t = build({ script: [answerTurn("x")], machines: [laptop, desk] });
		expect(await t.tool.execute({ goal: "look", machine: "Phone" }, t.ctx)).toEqual({
			error: expect.stringContaining("Available: Laptop, Desk"),
		});
		expect("resultText" in (await t.tool.execute({ goal: "look", machine: "desk" }, t.ctx))).toBe(
			true
		);
	});

	it("allows one task at a time on a machine", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const t = build({ script: [answerTurn("x")], leases: memoryLeaseStore() });
		const slow = t.runtime.snapshot.bind(t.runtime);
		t.runtime.snapshot = async () => {
			await gate;
			return slow();
		};
		const first = t.tool.execute({ goal: "look slowly" }, t.ctx);
		const second = await t.tool.execute({ goal: "look too" }, t.ctx);
		expect(second).toEqual({ error: expect.stringContaining("already in use") });
		release();
		await first;
		// Free again afterwards, even though the first one finished.
		expect("resultText" in (await t.tool.execute({ goal: "look again" }, t.ctx))).toBe(true);
	});

	it("releases the machine when the task fails, so the next one can run", async () => {
		const leases = memoryLeaseStore();
		const t = build({ script: [answerTurn("x")], leases });
		t.runtime.failNext.snapshot = new Error("boom");
		const first = await t.tool.execute({ goal: "look" }, t.ctx);
		expect("resultText" in first || "error" in first).toBe(true);
		expect("resultText" in (await t.tool.execute({ goal: "look again" }, t.ctx))).toBe(true);
	});

	it("asks the lease store for the device and the user, with a holder per call", async () => {
		const acquire = vi.fn(async () => ({ release: async () => {} }));
		const t = build({ script: [answerTurn("x")], leases: { acquire } });
		await t.tool.execute({ goal: "look" }, t.ctx);
		expect(acquire).toHaveBeenCalledWith(
			laptop.id,
			expect.anything(),
			expect.stringContaining("call-uuid")
		);
	});

	it("is refused after the user stopped the turn", async () => {
		const t = build({ script: [answerTurn("x")] });
		const out = await t.tool.execute(
			{ goal: "look" },
			{ ...t.ctx, abortSignal: AbortSignal.abort() }
		);
		expect(out).toEqual({ error: "Aborted by user" });
	});

	it("without a chat to ask in, a commit is refused rather than run", async () => {
		const runtime = new FakeBrowserRuntime(pages());
		const model = scriptedModel([
			callTurn("act", { actions: [{ type: "click", ref: "e1" }] }),
			answerTurn("could not pay"),
		]);
		const tool = createBrowseTool({
			machines: [laptop],
			settings: settings(),
			ceiling: "ask",
			userId: new ObjectId(),
			runtimeFor: () => runtime,
			grantKeyFor: async () => FAKE_BROWSER_KEY,
			leases: memoryLeaseStore(),
			completeFor: () => model.complete,
		});
		tool.bind(turnDeps);
		await tool.execute({ goal: "pay" }, { uuid: "u", toolCallId: "c" });
		expect(runtime.performed).toEqual([]);
	});
});

describe("browse: when it is offered", () => {
	const base = {
		conv: { _id: new ObjectId(), plan: undefined, webSearch: undefined },
		toolsEnabled: true,
	};
	const offered = (params: Parameters<typeof getEnabledBuiltinTools>[0]) =>
		getEnabledBuiltinTools(params).some((t) => t.name === BROWSE_TOOL_NAME);
	const browse = {
		machines: [laptop],
		settings: settings(),
		ceiling: "ask" as const,
	};

	it("is offered with an online machine that has a browser", () => {
		expect(offered({ ...base, browse })).toBe(true);
	});
	it("is not offered without one, without tool calling, or when not resolved", () => {
		expect(offered({ ...base, browse: { ...browse, machines: [] } })).toBe(false);
		expect(offered({ ...base, toolsEnabled: false, browse })).toBe(false);
		expect(offered({ ...base })).toBe(false);
	});
	it("is marked as returning outside content", () => {
		const tool = getEnabledBuiltinTools({ ...base, browse }).find(
			(t) => t.name === BROWSE_TOOL_NAME
		);
		expect(tool?.definition.function.description).toContain("comes from outside");
	});
	it("is not available to a delegated sub-agent", () => {
		expect(SUBAGENT_BUILTIN_TOOLS.has(BROWSE_TOOL_NAME)).toBe(false);
	});
});

describe("openAiComplete", () => {
	const turn = {
		choices: [
			{
				finish_reason: "tool_calls",
				message: {
					content: null,
					tool_calls: [{ id: "c1", type: "function", function: { name: "act", arguments: "{}" } }],
				},
			},
		],
		usage: { total_tokens: 321 },
	};

	function deps(create: ReturnType<typeof vi.fn>) {
		return {
			openai: { chat: { completions: { create } } },
			completionBase: {
				model: "chat-model",
				temperature: 0.2,
				max_tokens: 900,
				tools: [{ type: "function" }],
				tool_choice: "auto",
				stream: true,
			},
			requestHeaders: { Authorization: "Bearer user-token", "ChatUI-Conversation-ID": "c" },
		} as unknown as NestedAgentDeps;
	}

	it("calls the gateway with the user's own token, without the chat's tools", async () => {
		const create = vi.fn(async () => turn);
		const complete = openAiComplete(deps(create), "chat-model", true);
		const result = await complete({ messages: [{ role: "user", content: "hi" }], tools: [] });
		const [request, options] = create.mock.calls[0] as unknown as [
			Record<string, unknown>,
			{ headers: Record<string, string> },
		];
		expect(options.headers.Authorization).toBe("Bearer user-token");
		expect(request).toMatchObject({ model: "chat-model", stream: false, temperature: 0.2 });
		expect(request.tools).toBeUndefined();
		expect(request.tool_choice).toBeUndefined();
		expect(result).toEqual({
			content: null,
			toolCalls: [{ id: "c1", name: "act", arguments: "{}" }],
			finishReason: "tool_calls",
			totalTokens: 321,
		});
	});

	it("does not carry the chat model's sampling over to another model", async () => {
		const create = vi.fn(async () => turn);
		const complete = openAiComplete(deps(create), "browser-model", false);
		await complete({ messages: [], tools: [{ type: "function", function: { name: "act" } }] });
		const [request] = create.mock.calls[0] as unknown as [Record<string, unknown>];
		expect(request.model).toBe("browser-model");
		expect(request.temperature).toBeUndefined();
		expect(request.max_tokens).toBeUndefined();
		expect(request.tool_choice).toBe("auto");
	});
});
