/**
 * Tabs, verifications and the page left open (ADR 0116): the user's own tab is adopted only with an
 * approval that binds it; a bot check pauses the task for the user and is never solved by the
 * model; the last page stays open and the next task of the conversation resumes it.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Approver, ApprovalAsk } from "./approvals";
import { actionDigest, classifyAction, describeAction } from "./classifier";
import { FAKE_BROWSER_KEY, FakeBrowserRuntime, type FakePage } from "./fakeRuntime";
import { answerTurn, callTurn, scriptedModel, toolTexts, type ScriptedTurn } from "./fakeModel";
import { runBrowseLoop, type KeptPage, type LoopDeps } from "./loop";
import { decide } from "./policy";

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
		elements: [{ ref: "e1", role: "heading", name: "Cart" }],
	},
	{
		id: "flights",
		url: "https://flights.example.com/search#results",
		title: "Flights to Oslo",
		userTab: true,
		elements: [{ ref: "e1", role: "heading", name: "Cheapest: 89" }],
	},
];

const budgets = { maxSteps: 12, maxTokens: 100_000, maxSeconds: 300 };

function setup(script: ScriptedTurn[], approver?: Approver, deps: Partial<LoopDeps> = {}) {
	const runtime = new FakeBrowserRuntime(pages(), "home");
	const model = scriptedModel(script);
	const asks: ApprovalAsk[] = [];
	const approve: Approver =
		approver ??
		(async (ask) => {
			asks.push(ask);
			return { verdict: "approved", id: `a${asks.length}` };
		});
	const full: LoopDeps = {
		runtime,
		grantKey: FAKE_BROWSER_KEY,
		complete: model.complete,
		approve: async (ask, signal) => {
			if (approver) asks.push(ask);
			return approve(ask, signal);
		},
		rules: { allow: [], deny: [] },
		ceiling: "ask",
		budgets,
		...deps,
	};
	return { runtime, model, asks, deps: full };
}

describe("tabs and use_tab", () => {
	const use = () => callTurn("act", { actions: [{ type: "use_tab", tab: "flights" }] });

	it("lists the user's tabs, asks before adopting one, then works in it", async () => {
		const { runtime, model, asks, deps } = setup([
			callTurn("tabs", {}),
			use(),
			answerTurn("The cheapest is 89."),
		]);
		const result = await runBrowseLoop({ goal: "what is on this page" }, deps);
		expect(toolTexts(model.requests[1].messages).join("\n")).toContain("the user's own tab");
		expect(asks).toHaveLength(1);
		expect(asks[0].sentence).toBe(
			'Let Cerea use your tab "Flights to Oslo" (flights.example.com)?'
		);
		expect(asks[0].reason).toBe("user-tab");
		expect(asks[0].url).toBe("https://flights.example.com/search");
		expect(runtime.url).toBe("https://flights.example.com/search#results");
		expect(result.stopped_reason).toBeUndefined();
	});

	it("is asked about even on an allow-listed site", async () => {
		const { asks, deps } = setup([callTurn("tabs", {}), use(), answerTurn("ok")], undefined, {
			rules: { allow: ["flights.example.com", "shop.example.com"], deny: [] },
		});
		await runBrowseLoop({ goal: "use my tab" }, deps);
		expect(asks).toHaveLength(1);
	});

	it("is refused when the tab changed while the user decided", async () => {
		const retitled: { runtime?: FakeBrowserRuntime } = {};
		const { runtime, model, deps } = setup(
			[callTurn("tabs", {}), use(), answerTurn("stopped")],
			async () => {
				retitled.runtime?.retitle("flights", "A different page");
				return { verdict: "approved", id: "a1" };
			}
		);
		retitled.runtime = runtime;
		await runBrowseLoop({ goal: "use my tab" }, deps);
		expect(runtime.performed.some((a) => a.type === "use_tab")).toBe(false);
		expect(toolTexts(model.requests[2].messages).join("\n")).toContain("REFUSED");
	});

	it("needs the tab to have been listed first", async () => {
		const { runtime, asks, deps } = setup([use(), answerTurn("done")]);
		await runBrowseLoop({ goal: "use my tab" }, deps);
		expect(asks).toHaveLength(0);
		expect(runtime.performed).toEqual([]);
	});

	it("is always a commit, bound to the tab id, address without fragment and title", () => {
		const tab = { id: "t9", url: "https://flights.example.com/s?q=1#frag", title: "Flights" };
		const action = { type: "use_tab", tab: "t9" } as const;
		const ctx = { currentUrl: "https://shop.example.com/", tab };
		expect(classifyAction(action, ctx)).toEqual({
			class: "commit",
			reason: "user-tab",
			targetHost: "flights.example.com",
		});
		expect(describeAction(action, ctx)).toBe(
			'Let Cerea use your tab "Flights" (flights.example.com)?'
		);
		const expected = createHash("sha256")
			.update(
				JSON.stringify([
					"use_tab",
					"t9",
					"",
					"https://flights.example.com/s?q=1",
					"Flights",
					"user-tab",
					"",
					"0",
				])
			)
			.digest("hex")
			.slice(0, 32);
		expect(actionDigest(action, ctx)).toBe(expected);
		// A tab that moved or was retitled no longer matches.
		expect(actionDigest(action, { ...ctx, tab: { ...tab, title: "Other" } })).not.toBe(expected);
		expect(actionDigest(action, { ...ctx, tab: { ...tab, url: "https://x.test/" } })).not.toBe(
			expected
		);
		// No allow list covers it; a deny list does.
		const decision = (rules: { allow: string[]; deny: string[] }) =>
			decide({
				classification: classifyAction(action, ctx),
				currentHost: "shop.example.com",
				rules,
				ceiling: "ask",
			}).verdict;
		expect(decision({ allow: ["flights.example.com"], deny: [] })).toBe("ask");
		expect(decision({ allow: [], deny: ["flights.example.com"] })).toBe("deny");
	});
});

describe("verifications", () => {
	it("pauses the task for the user, who solves it; the wait is not task time", async () => {
		let clock = 1_000_000;
		const runtime = new FakeBrowserRuntime(pages(), "home");
		runtime.raiseChallenge("turnstile");
		const model = scriptedModel([answerTurn("done")]);
		const asks: ApprovalAsk[] = [];
		const waits: Array<string | null> = [];
		const result = await runBrowseLoop(
			{ goal: "look" },
			{
				runtime,
				grantKey: FAKE_BROWSER_KEY,
				complete: model.complete,
				approve: async (ask) => {
					asks.push(ask);
					clock += 3_600_000; // an hour at the window
					runtime.solveChallenge();
					return { verdict: "approved", id: "c1" };
				},
				rules: { allow: [], deny: [] },
				ceiling: "ask",
				budgets,
				machineName: "Laptop",
				now: () => clock,
				observer: { waiting: (s) => waits.push(s) },
			}
		);
		expect(asks).toHaveLength(1);
		expect(asks[0].challenge).toEqual({ kind: "turnstile" });
		expect(asks[0].sentence).toBe(
			"A verification appeared in the browser on Laptop. Solve it in the window, then tap Continue."
		);
		expect(waits[0]).toBe(asks[0].sentence);
		expect(result.stopped_reason).toBeUndefined();
		// The model saw a fresh page, and was never given the check to solve.
		expect(JSON.stringify(model.requests)).not.toContain("turnstile");
	});

	it("stops the task when the user does not continue, and when nobody can be asked", async () => {
		const runtime = new FakeBrowserRuntime(pages(), "home");
		runtime.raiseChallenge("hcaptcha");
		const base = {
			runtime,
			grantKey: FAKE_BROWSER_KEY,
			complete: scriptedModel([answerTurn("x")]).complete,
			rules: { allow: [], deny: [] },
			ceiling: "ask" as const,
			budgets,
		};
		const declined = await runBrowseLoop(
			{ goal: "look" },
			{ ...base, approve: async () => ({ verdict: "denied" }) }
		);
		expect(declined.stopped_reason).toBe("verification");
		const unattended = await runBrowseLoop(
			{ goal: "look" },
			{ ...base, unattended: true, approve: async () => ({ verdict: "approved", id: "x" }) }
		);
		expect(unattended.stopped_reason).toBe("verification");
	});

	it("handles an act that the runtime refuses because of a verification", async () => {
		const runtime = new FakeBrowserRuntime(pages(), "home");
		let first = true;
		const model = scriptedModel([
			callTurn("act", { actions: [{ type: "click", ref: "e1" }] }),
			answerTurn("done"),
		]);
		const asks: ApprovalAsk[] = [];
		const result = await runBrowseLoop(
			{ goal: "open the cart" },
			{
				runtime,
				grantKey: FAKE_BROWSER_KEY,
				complete: async (request, signal) => {
					if (first) {
						first = false;
						runtime.raiseChallenge("recaptcha");
					}
					return model.complete(request, signal);
				},
				approve: async (ask) => {
					asks.push(ask);
					runtime.solveChallenge();
					return { verdict: "approved", id: "c1" };
				},
				rules: { allow: [], deny: [] },
				ceiling: "ask",
				budgets,
			}
		);
		expect(asks.filter((a) => a.challenge)).toHaveLength(1);
		expect(result.stopped_reason).toBeUndefined();
	});
});

describe("the page left open", () => {
	it("ends every task with keep, hands the token to the caller only, and resumes it next time", async () => {
		const runtime = new FakeBrowserRuntime(pages(), "home");
		const kept: Array<KeptPage | null> = [];
		const left: string[] = [];
		const base = {
			runtime,
			grantKey: FAKE_BROWSER_KEY,
			rules: { allow: [], deny: [] },
			ceiling: "ask" as const,
			budgets,
			approve: (async () => ({ verdict: "approved", id: "a" })) as Approver,
			onKept: (k: KeptPage | null) => void kept.push(k),
			observer: { keptOpen: (i: { title: string }) => left.push(i.title) },
		};
		const first = scriptedModel([
			callTurn("act", { actions: [{ type: "click", ref: "e1" }] }),
			answerTurn("In the cart."),
		]);
		const one = await runBrowseLoop(
			{ goal: "open the cart" },
			{ ...base, complete: first.complete }
		);
		expect(runtime.calls.at(-1)).toEqual({ tool: "end_task", args: { keep: true } });
		expect(kept).toHaveLength(1);
		expect(kept[0]?.title).toBe("Your cart");
		expect(left).toEqual(["Your cart"]);
		// The token reaches neither the model nor the result it returns.
		const token = kept[0]?.token ?? "";
		expect(token).not.toBe("");
		expect(JSON.stringify(first.requests)).not.toContain(token);
		expect(JSON.stringify(one)).not.toContain(token);

		// The next task continues on that page.
		runtime.calls.length = 0;
		const resumed: Array<{ title: string; changed: boolean }> = [];
		const second = scriptedModel([answerTurn("Still there.")]);
		await runBrowseLoop(
			{ goal: "what is on the page", resumeToken: token },
			{ ...base, complete: second.complete, observer: { resumed: (i) => resumed.push(i) } }
		);
		expect(runtime.calls[0]).toEqual({ tool: "resume", args: { token } });
		expect(resumed).toEqual([{ title: "Your cart", changed: false }]);
		expect(JSON.stringify(second.requests)).not.toContain(token);
		expect(JSON.stringify(second.requests[0].messages)).toContain("left open");
	});

	it("starts fresh, silently, when the page cannot be resumed", async () => {
		const runtime = new FakeBrowserRuntime(pages(), "home");
		const model = scriptedModel([answerTurn("Fresh.")]);
		const result = await runBrowseLoop(
			{ goal: "look", resumeToken: "no-such-token" },
			{
				runtime,
				grantKey: FAKE_BROWSER_KEY,
				complete: model.complete,
				approve: async () => ({ verdict: "denied" }),
				rules: { allow: [], deny: [] },
				ceiling: "ask",
				budgets,
			}
		);
		expect(result.result).toBe("Fresh.");
		expect(result.stopped_reason).toBeUndefined();
		expect(runtime.calls[0].tool).toBe("resume");
	});
});
