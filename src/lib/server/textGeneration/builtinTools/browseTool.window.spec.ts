/**
 * `browse` with a desktop window as the target (ADR 0122): the window beats a computer when the
 * turn came from one with its link up, and falls back to a computer otherwise. The window here is
 * a real registry entry whose "app" answers with the fake runtime, so the whole path (target
 * choice, the window's own lease, the grant key, the JSON-RPC relay) runs, with no socket.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { MessageUpdateType, type MessageUpdate } from "$lib/types/MessageUpdate";
import { FakeBrowserRuntime, type FakePage } from "$lib/server/browser/fakeRuntime";
import {
	answerTurn,
	callTurn,
	scriptedModel,
	type ScriptedTurn,
} from "$lib/server/browser/fakeModel";
import { memoryChoiceStore } from "$lib/server/browser/machineChoice";
import { memoryLeaseStore } from "$lib/server/browser/lease";
import type { BrowserSettings } from "$lib/server/browser/settings";
import {
	_resetWindowsForTests,
	handleWindowMessage,
	registerWindow,
	unregisterWindow,
	windowGrantKey,
	windowLeaseStore,
	type BrowserWindow,
} from "$lib/server/browser/windowRegistry";
import type { NestedAgentDeps } from "./nestedAgent";
import { createBrowseTool } from "./browseTool";

const must = <T>(value: T | null | undefined): T => {
	if (value === null || value === undefined) throw new Error("expected a value");
	return value;
};

const pages = (): FakePage[] => [
	{
		id: "cart",
		url: "https://shop.example.com/cart",
		title: "Your cart",
		elements: [{ ref: "e1", role: "button", name: "Pay €120", onClick: { goto: "done" } }],
	},
	{ id: "done", url: "https://shop.example.com/done", title: "Done", elements: [] },
];
const settings: BrowserSettings = {
	enabled: true,
	model: "",
	budgets: { maxSteps: 10, maxTokens: 100_000, maxSeconds: 300 },
	rules: { allow: [], deny: [] },
};
const laptop = { id: "a".repeat(24), name: "Laptop" };
const turnDeps = { completionBase: { model: "chat-model" } } as unknown as NestedAgentDeps;
const WID = "w".repeat(32);

afterEach(() => _resetWindowsForTests());

/** A linked window whose app answers with a fake runtime that checks grants under the window's own key. */
function linkedWindow(userId: ObjectId, opts: { silent?: boolean } = {}) {
	const ref: { fake?: FakeBrowserRuntime } = {};
	const win: BrowserWindow = registerWindow({
		userId: userId.toString(),
		sessionId: "sess",
		windowId: WID,
		key: windowGrantKey("secret", WID),
		transport: {
			send(text) {
				const m = JSON.parse(text);
				if (m.method !== "tools/call" || opts.silent) return;
				queueMicrotask(async () => {
					const r = await must(ref.fake).asRuntimeCall()(m.params.name, m.params.arguments);
					handleWindowMessage(
						win,
						JSON.stringify({
							jsonrpc: "2.0",
							id: m.id,
							result: {
								content: r.content ?? [{ type: "text", text: r.text }],
								...(r.isError ? { isError: true } : {}),
							},
						})
					);
				});
			},
			close() {},
		},
	});
	const runtime = new FakeBrowserRuntime(pages(), undefined, { key: win.key });
	ref.fake = runtime;
	return { win, fake: runtime };
}

function build(options: {
	script: ScriptedTurn[];
	userId: ObjectId;
	window?: BrowserWindow;
	machines?: (typeof laptop)[];
	userText?: string;
	unattended?: boolean;
	computerRuntime?: FakeBrowserRuntime;
}) {
	const model = scriptedModel(options.script);
	const asks: string[] = [];
	const computerRuntime = options.computerRuntime ?? new FakeBrowserRuntime(pages());
	const tool = createBrowseTool({
		machines: options.machines ?? [],
		...(options.window ? { window: options.window } : {}),
		settings,
		ceiling: "ask",
		userId: options.userId,
		unattended: options.unattended,
		latestUserText: () => options.userText ?? "",
		choiceStore: memoryChoiceStore({ devices: { [laptop.id]: "Laptop" } }),
		remember: async () => undefined,
		// The computer's side is injected; the window's side is NOT: it must use the window's own.
		...(options.window
			? {}
			: {
					runtimeFor: () => computerRuntime,
					leases: memoryLeaseStore(),
					grantKeyFor: async () => Buffer.alloc(32, 7),
				}),
		approver: async (ask) => {
			asks.push(ask.sentence);
			return { verdict: "approved", id: "a1" };
		},
		completeFor: () => model.complete,
	});
	tool.bind(turnDeps);
	const updates: MessageUpdate[] = [];
	const conversationId = new ObjectId();
	const ctx = {
		uuid: "call-uuid",
		conversationId,
		toolCallId: "call-1",
		elicitationSink: { conversationId, emit: (u: MessageUpdate) => void updates.push(u) },
	};
	return { tool, ctx, updates, asks, computerRuntime };
}
const cards = (updates: MessageUpdate[]) =>
	updates.filter((u) => u.type === MessageUpdateType.Browse) as Extract<
		MessageUpdate,
		{ type: MessageUpdateType.Browse }
	>[];

describe("browse: this window", () => {
	it("runs in the window when there is one, even with a computer ready, and the card says so", async () => {
		const userId = new ObjectId();
		const { win, fake } = linkedWindow(userId);
		const t = build({
			script: [callTurn("snapshot", {}), answerTurn("looked")],
			userId,
			window: win,
			machines: [laptop],
		});
		const out = await t.tool.execute({ goal: "look at the cart" }, t.ctx);
		expect(JSON.parse((out as { resultText: string }).resultText)).toMatchObject({
			result: "looked",
		});
		expect(fake.calls.map((c) => c.tool)).toContain("snapshot");
		expect(t.computerRuntime.calls).toEqual([]);
		const last = cards(t.updates).at(-1);
		expect(last).toMatchObject({ status: "done", where: { kind: "window" } });
	});

	it("a commit still asks, and the grant the window's own key signed is accepted by the app's runtime", async () => {
		const userId = new ObjectId();
		const { win, fake } = linkedWindow(userId);
		const t = build({
			script: [callTurn("act", { actions: [{ type: "click", ref: "e1" }] }), answerTurn("paid")],
			userId,
			window: win,
		});
		await t.tool.execute({ goal: "pay" }, t.ctx);
		expect(t.asks).toEqual(['Click "Pay €120" on shop.example.com']);
		expect(fake.calls.some((c) => c.tool === "act")).toBe(true);
		expect(cards(t.updates).at(-1)?.status).toBe("done");
	});

	it("falls back to a computer when there is no window, and the card names the computer", async () => {
		const userId = new ObjectId();
		const t = build({
			script: [callTurn("snapshot", {}), answerTurn("looked")],
			userId,
			machines: [laptop],
		});
		await t.tool.execute({ goal: "look" }, t.ctx);
		expect(t.computerRuntime.calls.map((c) => c.tool)).toContain("snapshot");
		expect(cards(t.updates).at(-1)).toMatchObject({ where: { kind: "computer", name: "Laptop" } });
	});

	it("with no window and no computer there is nothing to run on", async () => {
		const t = build({ script: [], userId: new ObjectId() });
		expect(await t.tool.execute({ goal: "look" }, t.ctx)).toEqual({
			error: expect.stringContaining("No computer"),
		});
	});

	it("a computer is used instead only when the user's own words name it", async () => {
		const userId = new ObjectId();
		const { win, fake } = linkedWindow(userId);
		const named = build({
			script: [callTurn("snapshot", {}), answerTurn("ok")],
			userId,
			window: win,
			machines: [laptop],
			userText: "check the cart on my Laptop",
		});
		// the computer's side is not injected when a window is given: give it a real runtime path via seams
		const t = createBrowseTool({
			machines: [laptop],
			window: win,
			settings,
			ceiling: "ask",
			userId,
			latestUserText: () => "check the cart on my Laptop",
			choiceStore: memoryChoiceStore({ devices: { [laptop.id]: "Laptop" } }),
			remember: async () => undefined,
			runtimeFor: () => named.computerRuntime,
			leases: memoryLeaseStore(),
			grantKeyFor: async () => Buffer.alloc(32, 7),
			approver: async () => ({ verdict: "approved", id: "a" }),
			completeFor: () => scriptedModel([callTurn("snapshot", {}), answerTurn("ok")]).complete,
		});
		t.bind(turnDeps);
		await t.execute({ goal: "look", machine: "Laptop" }, named.ctx);
		expect(named.computerRuntime.calls.map((c) => c.tool)).toContain("snapshot");
		expect(fake.calls).toEqual([]);
	});

	it("an unattended run never uses a window", async () => {
		const userId = new ObjectId();
		const { win, fake } = linkedWindow(userId);
		const t = build({ script: [], userId, window: win, unattended: true, machines: [] });
		const out = await t.tool.execute({ goal: "look" }, t.ctx);
		expect(out).toMatchObject({ error: expect.any(String) });
		expect(fake.calls).toEqual([]);
	});

	it("one task at a time in a window; free again afterwards", async () => {
		const userId = new ObjectId();
		const { win } = linkedWindow(userId, { silent: true });
		// hold the window's lease the way a running task does
		const held = await windowLeaseStore().acquire(WID, userId, "other-task");
		expect(held).not.toBeNull();
		const t = build({ script: [answerTurn("x")], userId, window: win });
		expect(await t.tool.execute({ goal: "look" }, t.ctx)).toEqual({
			error: expect.stringContaining("already in use"),
		});
		await must(held).release();
	});

	it("ends the task with a clear error and releases the lease when the window goes mid-task", async () => {
		const userId = new ObjectId();
		const { win, fake } = linkedWindow(userId);
		let dropped = false;
		const slow = fake.asRuntimeCall();
		void slow;
		const t = build({
			script: [callTurn("snapshot", {}), callTurn("snapshot", {}), answerTurn("never")],
			userId,
			window: win,
		});
		const realSnapshot = fake.snapshot.bind(fake);
		fake.snapshot = async () => {
			if (!dropped) {
				dropped = true;
				// the app's window closes while the call is in flight
				queueMicrotask(() => unregisterWindow(win, "the window was closed"));
				await new Promise(() => undefined);
			}
			return realSnapshot();
		};
		const out = await t.tool.execute({ goal: "look" }, t.ctx);
		const text = JSON.stringify(out);
		expect(text).toMatch(/the app's window was closed, or the app switched to another server/);
		expect(cards(t.updates).at(-1)?.status).toMatch(/failed|stopped/);
		// the lease is free for the next window of that id
		registerWindow({
			userId: userId.toString(),
			sessionId: "sess",
			windowId: WID,
			key: windowGrantKey("secret", WID),
			transport: { send() {}, close() {} },
		});
		expect(await windowLeaseStore().acquire(WID, userId, "next")).not.toBeNull();
	});

	it("opens a page in the window with no task, tied to the chat in the window's own kept store", async () => {
		const userId = new ObjectId();
		const { win, fake } = linkedWindow(userId);
		const t = build({ script: [], userId, window: win });
		const out = await t.tool.execute(
			{ open_only: true, start_url: "https://shop.example.com/cart" },
			t.ctx
		);
		const body = JSON.parse((out as { resultText: string }).resultText);
		expect(body).toMatchObject({
			opened: true,
			computer: "this app",
			url: "https://shop.example.com/cart",
		});
		expect(fake.calls.map((c) => c.tool)).toEqual(["open"]);
		expect(await win.kept.get(WID, userId, t.ctx.conversationId.toString())).toBeDefined();
	});
});
