import { describe, it, expect } from "vitest";
import { MessageUpdateType, type MessagePlanUpdate } from "$lib/types/MessageUpdate";
import type { Message } from "$lib/types/Message";
import type { PlanStep } from "$lib/types/Plan";
import { latestPlan, planIsActive, planKey, planProgress } from "./codeTasks";

const plan = (steps: PlanStep[], version = 1): MessagePlanUpdate => ({
	type: MessageUpdateType.Plan,
	uuid: "agent-plan-s1",
	goal: "",
	version,
	steps,
});
const message = (updates: Message["updates"]): Message =>
	({ id: "m", from: "assistant", content: "", updates }) as Message;

describe("latestPlan", () => {
	it("is the last plan update in the session, across messages", () => {
		const first = plan([{ step: "a", status: "pending" }], 1);
		const second = plan([{ step: "a", status: "completed" }], 2);
		expect(latestPlan([message([first]), message([]), message([first, second])])).toBe(second);
	});
	it("is null when the session never made a list", () => {
		expect(latestPlan([message([{ type: MessageUpdateType.Stream, token: "x" }])])).toBeNull();
		expect(latestPlan([])).toBeNull();
	});
});

describe("latestPlan memo", () => {
	const chatter = (n: number) => message([{ type: MessageUpdateType.Stream, token: `t${n}` }]);
	const reads = (m: Message) => {
		let count = 0;
		const proxy = new Proxy(m, {
			get(target, key, receiver) {
				if (key === "updates") count += 1;
				return Reflect.get(target, key, receiver);
			},
		});
		return { proxy, count: () => count };
	};

	it("only rescans messages appended since the last call", () => {
		const probes = Array.from({ length: 5 }, (_, i) => reads(chatter(i)));
		const messages = probes.map((p) => p.proxy);
		expect(latestPlan(messages)).toBeNull();
		probes.forEach((p) => expect(p.count()).toBe(1));

		messages.push(chatter(5));
		expect(latestPlan(messages)).toBeNull();
		// The old ones: the previously-last message is read once more, the rest not at all.
		expect(probes.map((p) => p.count())).toEqual([1, 1, 1, 1, 2]);
	});

	it("finds a plan that arrives in a later message, and keeps one found earlier", () => {
		const first = plan([{ step: "a", status: "pending" }], 1);
		const messages = [message([first]), chatter(1)];
		expect(latestPlan(messages)).toBe(first);
		messages.push(chatter(2));
		expect(latestPlan(messages)).toBe(first);
		const second = plan([{ step: "a", status: "completed" }], 2);
		messages.push(message([second]));
		expect(latestPlan(messages)).toBe(second);
		messages.push(chatter(3));
		expect(latestPlan(messages)).toBe(second);
	});

	it("sees a plan streamed into the last message, and is not stuck on another session", () => {
		const messages = [chatter(1), message([])];
		expect(latestPlan(messages)).toBeNull();
		const live = plan([{ step: "a", status: "in_progress" }]);
		messages[1].updates = [live];
		expect(latestPlan(messages)).toBe(live);

		const other = plan([{ step: "z", status: "pending" }]);
		expect(latestPlan([message([other]), chatter(9), chatter(10)])).toBe(other);
		expect(latestPlan([chatter(1), chatter(2), chatter(3)])).toBeNull();
	});

	it("drops the cache when history is cut back", () => {
		const first = plan([{ step: "a", status: "pending" }]);
		const messages = [chatter(0), message([first]), chatter(1), chatter(2)];
		expect(latestPlan(messages)).toBe(first);
		expect(latestPlan(messages.slice(0, 1).concat(chatter(7)))).toBeNull();
	});
});

describe("planIsActive", () => {
	const working = plan([{ step: "a", status: "in_progress" }]);
	const queued = plan([{ step: "a", status: "pending" }]);
	const finished = plan([{ step: "a", status: "completed" }]);
	it("counts an in-progress item, busy or not", () => {
		expect(planIsActive(working, false)).toBe(true);
	});
	it("counts unfinished items only while the session is busy", () => {
		expect(planIsActive(queued, true)).toBe(true);
		expect(planIsActive(queued, false)).toBe(false);
	});
	it("ignores a finished list and no list", () => {
		expect(planIsActive(finished, true)).toBe(false);
		expect(planIsActive(null, true)).toBe(false);
	});
});

describe("planProgress and planKey", () => {
	it("counts completed over all items", () => {
		const p = plan([
			{ step: "a", status: "completed" },
			{ step: "b", status: "skipped" },
			{ step: "c", status: "pending" },
		]);
		expect(planProgress(p)).toEqual({ done: 1, total: 3 });
		expect(planProgress(null)).toEqual({ done: 0, total: 0 });
	});
	it("keys a list by session and its first item, not its progress", () => {
		const before = plan([{ step: "a", status: "pending" }]);
		const after = plan([{ step: "a", status: "completed" }], 2);
		expect(planKey("s1", before)).toBe(planKey("s1", after));
		expect(planKey("s2", before)).not.toBe(planKey("s1", before));
		expect(planKey("s1", plan([{ step: "other", status: "pending" }]))).not.toBe(
			planKey("s1", before)
		);
	});
});
