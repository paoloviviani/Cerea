import { describe, expect, it, vi } from "vitest";
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";
import { FirstTurnTracker } from "./firstTurnTracker.svelte";

const user = (text: string): AgentStreamUpdate => ({ type: "user", text });

describe("FirstTurnTracker", () => {
	it("reads the subagent's transcript once per ask, and answers from it", async () => {
		const load = vi.fn(async () => [user("start")]);
		const tracker = new FirstTurnTracker(load);
		expect(tracker.isFirst("c1", "a1")).toBe(false); // unknown until read
		tracker.ensure("c1", "a1");
		tracker.ensure("c1", "a1");
		await vi.waitFor(() => expect(tracker.isFirst("c1", "a1")).toBe(true));
		tracker.ensure("c1", "a1");
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("reads again for a later ask: the subagent may have had its next turn by then", async () => {
		let turns = 1;
		const load = vi.fn(async () => Array.from({ length: turns }, () => user("m")));
		const tracker = new FirstTurnTracker(load);
		tracker.ensure("c1", "a1");
		await vi.waitFor(() => expect(tracker.isFirst("c1", "a1")).toBe(true));
		turns = 2;
		tracker.ensure("c1", "a2");
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(tracker.isFirst("c1", "a2")).toBe(false));
		expect(tracker.isFirst("c1", "a1")).toBe(true);
	});

	it("a failed read is a no, never a claim", async () => {
		const tracker = new FirstTurnTracker(async () => {
			throw new Error("offline");
		});
		tracker.ensure("c1", "a1");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(tracker.isFirst("c1", "a1")).toBe(false);
	});

	it("keeps the child id it was given", () => {
		expect(new FirstTurnTracker(async () => [], "child-9").childId).toBe("child-9");
	});
});
