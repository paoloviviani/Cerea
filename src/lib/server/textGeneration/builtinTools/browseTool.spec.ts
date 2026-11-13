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
import { memoryKeptStore } from "$lib/server/browser/kept";
import { memoryLeaseStore, type LeaseStore } from "$lib/server/browser/lease";
import { memoryChoiceStore } from "$lib/server/browser/machineChoice";
import type { ComputerAsker } from "$lib/server/browser/computerAsk";
import type { NestedAgentDeps } from "./nestedAgent";

const saveBrowserDownloads = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/browser/downloads", () => ({ saveBrowserDownloads }));

import { liveTaskFor } from "$lib/server/browser/liveView";
import { BROWSE_TOOL_NAME, createBrowseTool, openAiComplete } from "./browseTool";
import { getEnabledBuiltinTools } from "./index";
import { SUBAGENT_BUILTIN_TOOLS } from "./delegateTool";

function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("expected a value");
	return value;
}

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
	choice?: ReturnType<typeof memoryChoiceStore>;
	asker?: ComputerAsker;
	unattended?: boolean;
	userText?: string;
	approve2?: boolean;
	keptStore?: ReturnType<typeof memoryKeptStore>;
}) {
	const runtime = options.runtime ?? new FakeBrowserRuntime(pages());
	const model = scriptedModel(options.script);
	const models: string[] = [];
	const asks: string[] = [];
	const remembered: Array<[string, string]> = [];
	const defaults: string[] = [];
	const userId = new ObjectId();
	const tool = createBrowseTool({
		machines: options.machines ?? [laptop],
		settings: options.settings ?? settings(),
		ceiling: "ask",
		userId,
		unattended: options.unattended,
		latestUserText: () => options.userText ?? "",
		choiceStore:
			options.choice ??
			memoryChoiceStore({ devices: { [laptop.id]: "Laptop", [desk.id]: "Desk" } }),
		asker: options.asker,
		keptStore: options.keptStore,
		remember: async (_user, conversation, device) => {
			remembered.push([conversation, device]);
		},
		saveDefault: async (_user, device) => {
			defaults.push(device);
		},
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
	const conversationId = new ObjectId();
	const ctx = {
		uuid: "call-uuid",
		conversationId,
		toolCallId: "call-1",
		elicitationSink: {
			conversationId,
			emit: (u: MessageUpdate) => void updates.push(u),
		},
	};
	return { tool, runtime, model, models, asks, updates, ctx, remembered, defaults, userId };
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

describe("browse: live view and takeover", () => {
	it("registers the running task for its owner only, and takeover pauses it until the hand-back", async () => {
		let seen: ReturnType<typeof liveTaskFor>;
		let stranger: ReturnType<typeof liveTaskFor> = undefined;
		const holder: { userId?: ObjectId } = {};
		const t = build({
			script: [
				async () => {
					seen = liveTaskFor("call-uuid", must(holder.userId).toString());
					stranger = liveTaskFor("call-uuid", new ObjectId().toString());
					await seen?.takeover();
					setTimeout(() => void seen?.handBack(), 40);
					return callTurn("snapshot", {});
				},
				answerTurn("looked"),
			] as never,
		});
		holder.userId = t.userId;
		const out = await t.tool.execute({ goal: "look at the cart" }, t.ctx);
		expect("resultText" in out).toBe(true);
		expect(seen).toBeDefined();
		expect(stranger).toBeUndefined();
		expect(seen?.info()).toMatchObject({ machineName: "Laptop", kind: "browse_task" });
		const cards = browseUpdates(t.updates);
		expect(cards.at(-1)).toMatchObject({ status: "done" });
		// The task is over: nothing is reachable any more.
		expect(liveTaskFor("call-uuid", t.userId.toString())).toBeUndefined();
		// The runtime was asked to give control back at the start, and again at the user's hand-back.
		const actions = t.runtime.calls
			.filter((c) => c.tool === "control")
			.map((c) => (c.args as { action: string }).action)
			.filter((a) => a !== "state");
		expect(actions).toEqual(["handback", "takeover", "handback"]);
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

	it("honours the machine hint only when it names a ready computer, else asks; it never picks", async () => {
		const asked: string[][] = [];
		const asker: ComputerAsker = async (options) => {
			asked.push(options.map((o) => o.name));
			return { verdict: "chosen", machine: options[1], remember: false };
		};
		const t = build({ script: [answerTurn("x")], machines: [laptop, desk], asker });
		// A name that is not one of the ready computers is no pick: the user is asked.
		await t.tool.execute({ goal: "look", machine: "Phone" }, t.ctx);
		expect(asked).toEqual([["Laptop", "Desk"]]);
		// An exact name (any case) is honoured with no question, when the user's message names it.
		const t2 = build({
			script: [answerTurn("x")],
			machines: [laptop, desk],
			asker,
			userText: "look at the news on my Desk",
		});
		expect("resultText" in (await t2.tool.execute({ goal: "look", machine: "desk" }, t2.ctx))).toBe(
			true
		);
		expect(asked).toHaveLength(1);
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
		const acquire = vi.fn(async () => ({ release: async () => {}, check: async () => true }));
		const t = build({ script: [answerTurn("x")], leases: { acquire } });
		await t.tool.execute({ goal: "look" }, t.ctx);
		expect(acquire).toHaveBeenCalledWith(
			laptop.id,
			expect.anything(),
			expect.stringContaining("call-uuid")
		);
	});

	it("stops with lease_lost when the machine's lease is lost before an action", async () => {
		const t = build({
			script: [callTurn("act", { actions: [{ type: "scroll" }] }), answerTurn("never")],
			leases: { acquire: async () => ({ release: async () => {}, check: async () => false }) },
		});
		const out = await t.tool.execute({ goal: "scroll" }, t.ctx);
		const body = JSON.parse((out as { resultText: string }).resultText);
		expect(body.stopped_reason).toBe("lease_lost");
		expect(browseUpdates(t.updates).at(-1)).toMatchObject({
			status: "stopped",
			stoppedReason: "lease_lost",
		});
		expect(t.runtime.performed).toEqual([]);
	});

	it("reads the site lists again from settings for each task", async () => {
		const rulesNow = vi.fn(() => ({ allow: [], deny: [] }));
		const runtime = new FakeBrowserRuntime(pages());
		const tool = createBrowseTool({
			machines: [laptop],
			settings: settings(),
			ceiling: "ask",
			userId: new ObjectId(),
			runtimeFor: () => runtime,
			grantKeyFor: async () => FAKE_BROWSER_KEY,
			leases: memoryLeaseStore(),
			rulesNow,
			completeFor: () => scriptedModel([answerTurn("ok")]).complete,
		});
		tool.bind(turnDeps);
		await tool.execute({ goal: "look" }, { uuid: "u", toolCallId: "c" });
		expect(rulesNow).toHaveBeenCalled();
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

describe("browse: the page left open", () => {
	function withStore(store: ReturnType<typeof memoryKeptStore>, runtime: FakeBrowserRuntime) {
		const models: ReturnType<typeof scriptedModel>[] = [];
		const make = () => {
			const model = scriptedModel([answerTurn("done")]);
			models.push(model);
			return model;
		};
		const tool = createBrowseTool({
			machines: [laptop],
			settings: settings(),
			ceiling: "ask",
			userId: new ObjectId(),
			runtimeFor: () => runtime,
			grantKeyFor: async () => FAKE_BROWSER_KEY,
			leases: memoryLeaseStore(),
			keptStore: store,
			approver: async () => ({ verdict: "approved", id: "a" }),
			completeFor: () => make().complete,
		});
		tool.bind(turnDeps);
		return { tool, models };
	}
	const run = async (
		tool: ReturnType<typeof createBrowseTool>,
		conversationId: ObjectId,
		updates: MessageUpdate[]
	) =>
		tool.execute({ goal: "look" }, {
			uuid: "u",
			toolCallId: "c",
			conversationId,
			elicitationSink: { conversationId, emit: (u: MessageUpdate) => void updates.push(u) },
		} as never);

	it("resumes in the same conversation, never in another, and never shows the token", async () => {
		const store = memoryKeptStore();
		const runtime = new FakeBrowserRuntime(pages());
		const { tool, models } = withStore(store, runtime);
		const conversation = new ObjectId();
		const updates: MessageUpdate[] = [];
		const first = await run(tool, conversation, updates);
		const token = [...store.tokens.values()][0];
		expect(token).toBeTruthy();
		expect(runtime.calls.some((c) => c.tool === "resume")).toBe(false);
		expect(browseUpdates(updates).at(-1)?.leftOpen).toBeTruthy();

		await run(tool, conversation, updates);
		expect(runtime.calls.some((c) => c.tool === "resume")).toBe(true);

		runtime.calls.length = 0;
		await run(tool, new ObjectId(), updates);
		expect(runtime.calls.some((c) => c.tool === "resume")).toBe(false);

		// Server side only: not in what the chat model reads, nor in what the client is sent.
		expect(JSON.stringify(first)).not.toContain(token);
		expect(JSON.stringify(updates)).not.toContain(token);
		for (const model of models) expect(JSON.stringify(model.requests)).not.toContain(token);
	});
});

describe("browse: the tool description on tabs", () => {
	it("says a lent tab continues across follow-ups in the same chat, and never opens a new tab for it", () => {
		const t = build({ script: [] });
		const description = t.tool.definition.function.description ?? "";
		expect(description).toContain("my tab");
		expect(description).toContain("never opens a new tab for it");
		expect(description).toContain("stays lent to this chat");
		expect(description).toContain(
			"follow-up requests in the same chat continue in it without asking again"
		);
		expect(description).toContain("never pass its address as `start_url`");
	});
});

describe("browse: a lent tab across requests", () => {
	const userPages = (): FakePage[] => [
		...pages(),
		{
			id: "form",
			url: "https://forms.example.com/jotform/abc",
			title: "Application form",
			userTab: true,
			elements: [{ ref: "e1", role: "textbox", name: "Name" }],
		},
	];
	function setupLent() {
		const runtime = new FakeBrowserRuntime(userPages());
		const store = memoryKeptStore();
		const asks: string[] = [];
		const scripts: ScriptedTurn[][] = [];
		const tool = createBrowseTool({
			machines: [laptop],
			settings: settings(),
			ceiling: "ask",
			userId: new ObjectId(),
			runtimeFor: () => runtime,
			grantKeyFor: async () => FAKE_BROWSER_KEY,
			leases: memoryLeaseStore(),
			keptStore: store,
			approver: async (ask) => {
				asks.push(ask.sentence);
				return { verdict: "approved", id: `a${asks.length}` };
			},
			completeFor: () => scriptedModel(scripts.shift() ?? [answerTurn("done")]).complete,
		});
		tool.bind(turnDeps);
		const run = (conversationId: ObjectId, script: ScriptedTurn[]) => {
			scripts.push(script);
			return tool.execute({ goal: "work on my tab" }, {
				uuid: "u",
				toolCallId: "c",
				conversationId,
				elicitationSink: { conversationId, emit: () => undefined },
			} as never);
		};
		return { runtime, store, asks, run };
	}
	const useForm = callTurn("act", { actions: [{ type: "use_tab", tab: "form" }] });

	it("asks once in a conversation, not again on the same site, and asks in another conversation", async () => {
		const { runtime, store, asks, run } = setupLent();
		const conversation = new ObjectId();
		await run(conversation, [callTurn("tabs", {}), useForm, answerTurn("done")]);
		expect(asks).toHaveLength(1);
		expect(store.lent.size).toBe(1);

		runtime.calls.length = 0;
		await run(conversation, [useForm, answerTurn("done again")]);
		expect(runtime.calls.some((c) => c.tool === "resume")).toBe(true);
		expect(asks).toHaveLength(1);

		// Another conversation sees a plain user tab.
		await run(new ObjectId(), [callTurn("tabs", {}), useForm, answerTurn("done")]);
		expect(asks).toHaveLength(2);
	});

	it("an unattended run never resumes a lent tab", async () => {
		const runtime = new FakeBrowserRuntime(userPages());
		const store = memoryKeptStore();
		const conversation = new ObjectId();
		const mk = (unattended: boolean, script: ScriptedTurn[]) => {
			const tool = createBrowseTool({
				machines: [laptop],
				settings: settings(),
				ceiling: "ask",
				userId: new ObjectId(),
				unattended,
				runtimeFor: () => runtime,
				grantKeyFor: async () => FAKE_BROWSER_KEY,
				leases: memoryLeaseStore(),
				keptStore: store,
				approver: async () => ({ verdict: "approved", id: "a" }),
				completeFor: () => scriptedModel(script).complete,
			});
			tool.bind(turnDeps);
			return () =>
				tool.execute({ goal: "work" }, {
					uuid: "u",
					toolCallId: "c",
					conversationId: conversation,
					elicitationSink: { conversationId: conversation, emit: () => undefined },
				} as never);
		};
		await mk(false, [callTurn("tabs", {}), useForm, answerTurn("done")])();
		expect(store.lent.size).toBe(1);
		runtime.calls.length = 0;
		await mk(true, [answerTurn("scheduled")])();
		expect(runtime.calls.some((c) => c.tool === "resume")).toBe(false);
	});

	it("a lent tab idle for an hour is a plain tab again (token and url)", async () => {
		let clock = Date.now();
		const store = memoryKeptStore(() => clock);
		const user = new ObjectId();
		await store.set("d", user, "c", {
			token: "t",
			id: "form",
			title: "x",
			url: "https://forms.example.com/jotform/abc",
			lent: true,
			origin: "https://forms.example.com",
		});
		expect(await store.get("d", user, "c")).toEqual({ token: "t", lent: true });
		expect(await store.url("d", user, "c")).toBe("https://forms.example.com/jotform/abc");
		clock += 61 * 60_000;
		expect(await store.get("d", user, "c")).toBeUndefined();
		expect(await store.url("d", user, "c")).toBeUndefined();
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
	it("leads with the capability and says so in the prompt exactly when it is offered", async () => {
		const { buildToolPreprompt } = await import("$lib/server/textGeneration/utils/toolPrompt");
		const withBrowse = getEnabledBuiltinTools({ ...base, browse });
		const tool = withBrowse.find((t) => t.name === BROWSE_TOOL_NAME);
		expect(tool?.definition.function.description).toMatch(
			/^Drive a real web browser on the user's own computer: /
		);
		const tools = withBrowse.map((t) => t.definition);
		const on = buildToolPreprompt(tools, undefined, withBrowse);
		expect(on).toContain("you CAN use a real web browser");
		// Cache-stable: nothing of the page or the machine's state is in the line.
		expect(buildToolPreprompt(tools, undefined, withBrowse)).toBe(on);
		const plain = getEnabledBuiltinTools({ ...base });
		const off = buildToolPreprompt(
			plain.map((t) => t.definition),
			undefined,
			plain
		);
		expect(off).not.toContain("real web browser on the user's own computer");
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
			requestHeaders: {
				Authorization: "Bearer user-token",
				"ChatUI-Conversation-ID": "c",
				"x-pystino-tag": "turn:m1",
				"x-bill-to": "org-1",
			},
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
		expect(options.headers["x-pystino-tag"]).toBe("turn:m1");
		expect(options.headers["x-bill-to"]).toBe("org-1");
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

describe("browse: which computer (rules, never the model)", () => {
	const chosen =
		(index: number, remember: boolean): ComputerAsker =>
		async (options) => ({
			verdict: "chosen",
			machine: options[index],
			remember,
		});

	it("uses the only ready computer without asking", async () => {
		const asker = vi.fn();
		const t = build({ script: [answerTurn("ok")], machines: [laptop], asker });
		const out = await t.tool.execute({ goal: "look" }, t.ctx);
		expect("resultText" in out).toBe(true);
		expect(asker).not.toHaveBeenCalled();
		expect(t.remembered).toEqual([[t.ctx.conversationId.toString(), laptop.id]]);
	});

	it("keeps a conversation on its computer, and says it is offline rather than jumping", async () => {
		const conversationId = new ObjectId();
		const choice = memoryChoiceStore({
			devices: { [laptop.id]: "Laptop", [desk.id]: "Desk" },
			conversation: { [conversationId.toString()]: desk.id },
		});
		const asker = vi.fn();
		const t = build({ script: [answerTurn("ok")], machines: [laptop], choice, asker });
		t.ctx.conversationId = conversationId;
		expect(await t.tool.execute({ goal: "look" }, t.ctx)).toEqual({ error: "Desk is offline." });
		expect(asker).not.toHaveBeenCalled();
		// Ready: used, even with another one ready and a different default.
		const t2 = build({
			script: [answerTurn("ok")],
			machines: [laptop, desk],
			choice: memoryChoiceStore({
				devices: { [laptop.id]: "Laptop", [desk.id]: "Desk" },
				conversation: { [conversationId.toString()]: desk.id },
				default: laptop.id,
			}),
			asker,
		});
		t2.ctx.conversationId = conversationId;
		await t2.tool.execute({ goal: "look" }, t2.ctx);
		expect(t2.remembered[0][1]).toBe(desk.id);
	});

	it("uses the user's default, and stops when it is offline", async () => {
		const choice = memoryChoiceStore({
			devices: { [laptop.id]: "Laptop", [desk.id]: "Desk" },
			default: desk.id,
		});
		const t = build({ script: [answerTurn("ok")], machines: [laptop, desk], choice });
		await t.tool.execute({ goal: "look" }, t.ctx);
		expect(t.remembered[0][1]).toBe(desk.id);
		const off = build({ script: [answerTurn("ok")], machines: [laptop], choice });
		expect(await off.tool.execute({ goal: "look" }, off.ctx)).toEqual({
			error: "Desk is offline.",
		});
	});

	it("asks which computer, saves the default when remembered, and runs there", async () => {
		const t = build({
			script: [answerTurn("ok")],
			machines: [laptop, desk],
			asker: chosen(1, true),
		});
		const out = await t.tool.execute({ goal: "look" }, t.ctx);
		expect("resultText" in out).toBe(true);
		expect(t.defaults).toEqual([desk.id]);
		expect(t.remembered[0][1]).toBe(desk.id);
	});

	it("does not save a default when 'Remember as default' is cleared", async () => {
		const t = build({
			script: [answerTurn("ok")],
			machines: [laptop, desk],
			asker: chosen(0, false),
		});
		await t.tool.execute({ goal: "look" }, t.ctx);
		expect(t.defaults).toEqual([]);
		expect(t.remembered[0][1]).toBe(laptop.id);
	});

	it("returns an error that tells the model not to choose when nobody answers", async () => {
		const t = build({
			script: [answerTurn("ok")],
			machines: [laptop, desk],
			asker: async () => ({ verdict: "expired" }),
		});
		const out = await t.tool.execute({ goal: "look" }, t.ctx);
		expect(out).toEqual({ error: expect.stringContaining("Do not choose one for them") });
		expect(t.runtime.calls).toEqual([]);
	});

	it("ignores a hint the user's message does not name, and in an unattended run", async () => {
		const asker = vi.fn(async (options: Array<{ id: string; name: string }>) => ({
			verdict: "chosen" as const,
			machine: options[0],
			remember: false,
		}));
		const t = build({
			script: [answerTurn("x")],
			machines: [laptop, desk],
			asker,
			userText: "look at the news",
		});
		await t.tool.execute({ goal: "look", machine: "Desk" }, t.ctx);
		expect(asker).toHaveBeenCalledTimes(1);
		expect(t.remembered[0][1]).toBe(laptop.id);
		const u = build({
			script: [answerTurn("x")],
			machines: [laptop, desk],
			asker,
			unattended: true,
			userText: "use Desk",
		});
		const out = await u.tool.execute({ goal: "look", machine: "Desk" }, u.ctx);
		expect(out).toEqual({ error: expect.stringContaining("Do not choose one yourself") });
		expect(asker).toHaveBeenCalledTimes(1);
	});

	it("never asks in an unattended run: it explains, and does not pick", async () => {
		const asker = vi.fn();
		const t = build({
			script: [answerTurn("ok")],
			machines: [laptop, desk],
			unattended: true,
			asker,
		});
		const out = await t.tool.execute({ goal: "look" }, t.ctx);
		expect(out).toEqual({ error: expect.stringContaining("Do not choose one yourself") });
		expect(asker).not.toHaveBeenCalled();
		expect(t.runtime.calls).toEqual([]);
	});
});

describe("browse: goal scoping and open_only", () => {
	const description = () => {
		const t = build({ script: [] });
		return t.tool.definition.function.description ?? "";
	};

	it("tells the model the goal is only the latest request, and what the machine argument is", () => {
		const text = description();
		expect(text).toContain("ONLY the user's latest request");
		expect(text).toContain("never resume, repeat or continue an earlier plan");
		expect(text).toContain("do not name a site");
		expect(text).toContain("`machine` is only a hint");
		expect(text).toContain("open_only");
	});

	it("the prompt line scopes the goal too", () => {
		const t = build({ script: [] });
		expect(t.tool.preprompt).toContain("latest message alone");
		expect(t.tool.preprompt).toContain("open_only");
	});

	it("opens a page and ties it to the conversation with no task and no model call", async () => {
		const kept = memoryKeptStore();
		const t = build({ script: [], keptStore: kept });
		const out = await t.tool.execute(
			{ open_only: true, start_url: "https://shop.example.com/cart" },
			t.ctx
		);
		const body = JSON.parse((out as { resultText: string }).resultText);
		expect(body).toMatchObject({
			opened: true,
			computer: "Laptop",
			url: "https://shop.example.com/cart",
		});
		expect(t.runtime.calls.map((c) => c.tool)).toEqual(["open"]);
		expect(t.models).toEqual([]);
		expect(kept.tokens.size).toBe(1);
	});
});

describe("browse: open_only to another site", () => {
	const convId = () => new ObjectId();
	async function withKept(
		url: string,
		options: { unattended?: boolean; approve?: "approved" | "denied" } = {}
	) {
		const kept = memoryKeptStore();
		const t = build({
			script: [],
			keptStore: kept,
			approve: options.approve,
			unattended: options.unattended,
		});
		const key = t.ctx.conversationId.toString();
		await kept.set(laptop.id, new ObjectId(), key, { token: "k", id: "x", title: "", url });
		return { t, kept };
	}

	it("opens directly with no kept page, or on the same site", async () => {
		const none = build({ script: [], keptStore: memoryKeptStore() });
		await none.tool.execute(
			{ open_only: true, start_url: "https://shop.example.com/cart" },
			none.ctx
		);
		expect(none.asks).toEqual([]);
		expect(none.runtime.calls.map((c) => c.tool)).toEqual(["open"]);
		const { t } = await withKept("https://shop.example.com/a?token=1");
		await t.tool.execute(
			{ open_only: true, start_url: "https://www.shop.example.com/cart" },
			t.ctx
		);
		expect(t.asks).toEqual([]);
		expect(t.runtime.calls.map((c) => c.tool)).toEqual(["open"]);
	});

	it("asks first when it would change site, and opens only when allowed", async () => {
		const { t } = await withKept("https://shop.example.com/a");
		await t.tool.execute({ open_only: true, start_url: "https://news.example.net/" }, t.ctx);
		expect(t.asks).toHaveLength(1);
		expect(t.asks[0]).toContain("leaving shop.example.com");
		expect(t.runtime.calls.map((c) => c.tool)).toEqual(["open"]);
		const denied = await withKept("https://shop.example.com/a", { approve: "denied" });
		const out = await denied.t.tool.execute(
			{ open_only: true, start_url: "https://news.example.net/" },
			denied.t.ctx
		);
		expect(out).toEqual({ error: expect.stringContaining("did not allow") });
		expect(denied.t.runtime.calls).toEqual([]);
	});

	it("is refused in an unattended run when it would change site", async () => {
		const { t } = await withKept("https://shop.example.com/a", { unattended: true });
		const out = await t.tool.execute(
			{ open_only: true, start_url: "https://news.example.net/" },
			t.ctx
		);
		expect(out).toEqual({ error: expect.stringContaining("nobody is here to ask") });
		expect(t.runtime.calls).toEqual([]);
		void convId;
	});
});
