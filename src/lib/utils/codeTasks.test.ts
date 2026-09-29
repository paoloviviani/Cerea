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
