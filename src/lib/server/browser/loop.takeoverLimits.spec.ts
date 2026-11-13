/** Takeover limits: a runtime that cannot hand back, a state call that cannot be asked, a takeover that never ends. */
import { describe, expect, it } from "vitest";
import { FAKE_BROWSER_KEY, FakeBrowserRuntime } from "./fakeRuntime";
import { answerTurn, callTurn, scriptedModel, type ScriptedTurn } from "./fakeModel";
import { runBrowseLoop, type LoopDeps } from "./loop";
import { TaskControl } from "./takeover";
import { BrowserRuntimeError, type ControlAction, type ControlResult } from "./contract";

const pages = [{ id: "home", url: "https://shop.example.com/", title: "Shop", elements: [] }];
const budgets = { maxSteps: 12, maxTokens: 100_000, maxSeconds: 300 };
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

function deps(
	runtime: FakeBrowserRuntime,
	script: Array<ScriptedTurn | (() => Promise<ScriptedTurn>)>,
	over: Partial<LoopDeps>
): LoopDeps {
	const model = scriptedModel(script as never);
	return {
		runtime,
		grantKey: FAKE_BROWSER_KEY,
		complete: model.complete,
		approve: async () => ({ verdict: "approved", id: "a" }),
		rules: { allow: [], deny: [] },
		ceiling: "ask",
		budgets,
		...over,
	};
}

describe("a runtime that says paused when the task has no way to wait", () => {
	it("ends the task with a clear reason instead of a crash", async () => {
		const runtime = new FakeBrowserRuntime(pages, "home");
		runtime.bannerTakeover();
		const result = await runBrowseLoop(
			{ goal: "look" },
			deps(runtime, [callTurn("snapshot", {}), answerTurn("done")], {})
		);
		expect(result.stopped_reason).toBe("no_handover");
	});
});

describe("a takeover that is never handed back", () => {
	it("ends the task as takeover_timeout after the longest wait, and says so", async () => {
		const runtime = new FakeBrowserRuntime(pages, "home");
		const control = new TaskControl(runtime, { pollMs: 10 });
		const result = await runBrowseLoop(
			{ goal: "look" },
			deps(
				runtime,
				[
					async () => {
						await control.takeover();
						return callTurn("snapshot", {});
					},
					answerTurn("done"),
				],
				{ control, maxTakeoverMs: 120 }
			)
		);
		expect(result.stopped_reason).toBe("takeover_timeout");
	});

	it("also when the user took control in the window of a scheduled run", async () => {
		const runtime = new FakeBrowserRuntime(pages, "home");
		const control = new TaskControl(runtime, { pollMs: 10 });
		runtime.bannerTakeover();
		const result = await runBrowseLoop(
			{ goal: "look" },
			deps(runtime, [callTurn("snapshot", {}), answerTurn("done")], {
				control,
				unattended: true,
				maxTakeoverMs: 120,
			})
		);
		expect(result.stopped_reason).toBe("takeover_timeout");
	});
});

describe("waiting for a hand-back when control(state) cannot be asked", () => {
	function stateBroken(runtime: FakeBrowserRuntime) {
		const original = runtime.control.bind(runtime);
		return {
			control: async (action: ControlAction): Promise<ControlResult> => {
				if (action === "state") throw new BrowserRuntimeError("no", "unavailable");
				return original(action);
			},
		};
	}

	it("falls back to a repeatable runtime call and learns the agent has the page again", async () => {
		const runtime = new FakeBrowserRuntime(pages, "home");
		const control = new TaskControl(stateBroken(runtime), {
			pollMs: 5,
			probeAfter: 2,
			probe: () => runtime.tabs({}),
		});
		await control.takeover();
		expect(control.paused()).toBe(true);
		const wait = control.waitForHandBack();
		await tick(60);
		expect(control.paused()).toBe(true); // tabs still answers paused
		runtime.bannerHandback(); // the user hands back in the window
		await wait;
		expect(control.paused()).toBe(false);
	});

	it("without a probe keeps waiting for the user's hand-back", async () => {
		const runtime = new FakeBrowserRuntime(pages, "home");
		const control = new TaskControl(stateBroken(runtime), { pollMs: 5, probeAfter: 1 });
		await control.takeover();
		const abort = new AbortController();
		const wait = control.waitForHandBack(abort.signal);
		await tick(40);
		expect(control.paused()).toBe(true);
		abort.abort();
		await wait;
	});
});

describe("the runtime's paused flag on an action's result", () => {
	it("tells the gate at once", async () => {
		const runtime = new FakeBrowserRuntime(
			[
				{
					id: "home",
					url: "https://shop.example.com/",
					title: "Shop",
					elements: [{ ref: "e1", role: "button", name: "Go" }],
				},
			],
			"home"
		);
		const original = runtime.act.bind(runtime);
		runtime.act = async (actions, grants) => ({
			...(await original(actions, grants)),
			paused: true,
		});
		let told = 0;
		const control = {
			paused: () => false,
			runtimePaused: () => {
				told += 1;
			},
			waitForHandBack: async () => {},
		};
		await runBrowseLoop(
			{ goal: "go" },
			deps(
				runtime,
				[callTurn("act", { actions: [{ type: "click", ref: "e1" }] }), answerTurn("ok")],
				{
					control,
				}
			)
		);
		expect(told).toBe(1);
	});
});
