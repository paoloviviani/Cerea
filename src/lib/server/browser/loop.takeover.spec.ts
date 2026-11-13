import { describe, expect, it } from "vitest";
import type { Approver, ApprovalAsk } from "./approvals";
import { FAKE_BROWSER_KEY, FakeBrowserRuntime, type FakePage } from "./fakeRuntime";
import { answerTurn, callTurn, scriptedModel, toolTexts, type ScriptedTurn } from "./fakeModel";
import { runBrowseLoop, type LoopDeps } from "./loop";
import { TaskControl } from "./takeover";

function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("expected a value");
	return value;
}

/** A shop with a cart: a read page, and a page whose button is a commit. */
const pages = (): FakePage[] => [
	{
		id: "home",
		url: "https://shop.example.com/",
		title: "Shop",
		elements: [{ ref: "e1", role: "link", name: "Cart", href: "/cart", onClick: { goto: "cart" } }],
	},
	{
		id: "cart",
		url: "https://shop.example.com/cart",
		title: "Your cart",
		elements: [{ ref: "e1", role: "button", name: "Pay €120", onClick: { goto: "paid" } }],
	},
	{
		id: "paid",
		url: "https://shop.example.com/thanks",
		title: "Thank you",
		elements: [{ ref: "e1", role: "heading", name: "Order placed" }],
	},
];

const budgets = { maxSteps: 12, maxTokens: 100_000, maxSeconds: 300 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const until = async (what: string, ok: () => boolean) => {
	for (let i = 0; i < 200 && !ok(); i += 1) await tick();
	if (!ok()) throw new Error(`timed out waiting for ${what}`);
};

function rig(options: {
	start?: string;
	script: Array<ScriptedTurn | (() => Promise<ScriptedTurn> | ScriptedTurn)>;
	approver?: Approver;
	deps?: Partial<LoopDeps>;
}) {
	const runtime = new FakeBrowserRuntime(pages(), options.start ?? "home");
	const control = new TaskControl(runtime, { pollMs: 10 });
	const model = scriptedModel([]);
	let at = 0;
	const asks: ApprovalAsk[] = [];
	const controlled: Array<"user" | null> = [];
	const clock = { offset: 0 };
	const deps: LoopDeps = {
		runtime,
		grantKey: FAKE_BROWSER_KEY,
		complete: async (request) => {
			model.requests.push({ messages: [...request.messages], tools: request.tools });
			const next = options.script[Math.min(at, options.script.length - 1)];
			at += 1;
			const turn =
				typeof next === "function"
					? await (next as (r: typeof request) => Promise<ScriptedTurn> | ScriptedTurn)(request)
					: next;
			return typeof turn === "function" ? turn(request) : turn;
		},
		approve:
			options.approver ??
			(async (ask) => {
				asks.push(ask);
				return { verdict: "approved", id: `approval-${asks.length}` };
			}),
		rules: { allow: [], deny: [] },
		ceiling: "ask",
		budgets,
		control,
		observer: { controlled: (by) => controlled.push(by) },
		now: () => Date.now() + clock.offset,
		...options.deps,
	};
	return { runtime, control, model, asks, controlled, clock, deps };
}

describe("takeover: the loop pauses while the user has the browser", () => {
	it("reads and acts on nothing while paused, and the wait is not task time", async () => {
		const r = rig({
			script: [
				// The user takes over while the model is thinking about its next step.
				async () => {
					await r.control.takeover();
					return callTurn("snapshot", {});
				},
				answerTurn("done"),
			],
		});
		const callsBefore = () => r.runtime.calls.filter((c) => c.tool !== "control").length;
		const run = runBrowseLoop({ goal: "look at the shop" }, r.deps);
		await until("the pause", () => r.controlled.includes("user"));
		const during = callsBefore();
		await tick();
		await tick();
		// Nothing reached the runtime while the user had it, and a long wait costs no budget.
		expect(callsBefore()).toBe(during);
		r.clock.offset += 3_600_000;
		await r.control.handBack();
		const result = await run;

		expect(result.stopped_reason).toBeUndefined();
		expect(result.result).toBe("done");
		expect(r.controlled).toEqual(["user", null]);
		// The snapshot the model asked for was not run before the hand-back, and the page was then
		// read afresh and shown to it.
		const texts = toolTexts(must(r.model.requests.at(-1)).messages).join("\n");
		expect(texts).toContain("Not run: the user took control");
		expect(texts).toContain("Shop");
		const actions = r.runtime.calls
			.filter((c) => c.tool === "control")
			.map((c) => (c.args as { action: string }).action);
		expect(actions[0]).toBe("takeover");
		expect(actions.at(-1)).toBe("handback");
		expect(actions.filter((a) => a !== "state")).toEqual(["takeover", "handback"]);
	});

	it("learns of a takeover in the headed window from the runtime, and waits for its hand-back", async () => {
		const r = rig({
			script: [
				callTurn("snapshot", {}),
				async () => {
					// The user clicked the banner: only the runtime knows.
					r.runtime.bannerTakeover();
					return callTurn("diff", {});
				},
				answerTurn("done"),
			],
		});
		const run = runBrowseLoop({ goal: "look" }, r.deps);
		await until("the pause", () => r.controlled.includes("user"));
		expect(r.control.paused()).toBe(true);
		const during = r.runtime.calls.length;
		await tick();
		await tick();
		// It only asked the runtime who has the page; it read nothing.
		expect(r.runtime.calls.slice(during).filter((c) => c.tool !== "control")).toEqual([]);
		// The user clicks "Hand back" in the window: the loop finds out by asking.
		r.runtime.bannerHandback();
		const result = await run;
		expect(result.result).toBe("done");
		expect(r.controlled).toEqual(["user", null]);
		expect(r.control.paused()).toBe(false);
	});

	it("does not run an action that was meant for the page before the user acted", async () => {
		const r = rig({
			start: "cart",
			script: [
				async () => {
					await r.control.takeover();
					return callTurn("act", { actions: [{ type: "click", ref: "e1" }] });
				},
				answerTurn("stopped"),
			],
		});
		const run = runBrowseLoop({ goal: "pay" }, r.deps);
		await until("the pause", () => r.controlled.includes("user"));
		await r.control.handBack();
		await run;
		expect(r.runtime.performed).toEqual([]);
		expect(r.asks).toEqual([]);
		expect(r.runtime.url).toBe("https://shop.example.com/cart");
	});

	it("still asks before a commit after the hand-back", async () => {
		const r = rig({
			start: "cart",
			script: [
				async () => {
					await r.control.takeover();
					return callTurn("snapshot", {});
				},
				callTurn("act", { actions: [{ type: "click", ref: "e1" }] }),
				answerTurn("paid"),
			],
		});
		const run = runBrowseLoop({ goal: "pay" }, r.deps);
		await until("the pause", () => r.controlled.includes("user"));
		await r.control.handBack();
		const result = await run;
		// The user's own acts were theirs; the agent's click is the agent's, and was asked about.
		expect(r.asks).toHaveLength(1);
		expect(r.asks[0].sentence).toContain("Pay");
		expect(r.runtime.performed.map((a) => a.type)).toEqual(["click"]);
		expect(result.final_url).toBe("https://shop.example.com/thanks");
	});

	it("is stopped by the user's Stop while paused", async () => {
		const abort = new AbortController();
		const r = rig({
			script: [
				async () => {
					await r.control.takeover();
					return callTurn("snapshot", {});
				},
			],
			deps: { signal: abort.signal },
		});
		const run = runBrowseLoop({ goal: "look" }, r.deps);
		await until("the pause", () => r.controlled.includes("user"));
		abort.abort();
		const result = await run;
		expect(result.stopped_reason).toBe("aborted");
	});

	it("ends the task when the runtime says paused and nothing can wait for it", async () => {
		const r = rig({
			script: [callTurn("snapshot", {}), answerTurn("done")],
			deps: { control: undefined },
		});
		r.runtime.bannerTakeover();
		const result = await runBrowseLoop({ goal: "look" }, r.deps);
		expect(result.stopped_reason).toBe("no_handover");
	});

	it("tells a surface when the agent needs the user, with the approval's id", async () => {
		const needs: Array<{ reason: string; approvalId?: string }> = [];
		const r = rig({
			start: "cart",
			script: [callTurn("act", { actions: [{ type: "click", ref: "e1" }] }), answerTurn("paid")],
			approver: async (ask) => {
				ask.onAsked?.("elicitation-1");
				return { verdict: "approved", id: "a1" };
			},
		});
		r.deps.observer = { needsUser: (n) => needs.push(n) };
		await runBrowseLoop({ goal: "pay" }, r.deps);
		expect(needs).toEqual([{ reason: "approval", approvalId: "elicitation-1" }]);
	});
});
