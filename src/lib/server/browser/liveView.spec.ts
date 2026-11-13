import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeBrowserRuntime } from "./fakeRuntime";
import {
	liveTaskFor,
	registerLiveTask,
	type LiveEvent,
	type LiveRuntime,
	type LiveViewer,
} from "./liveView";
import { TaskControl } from "./takeover";

function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("expected a value");
	return value;
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const payload = (w: number, h: number) =>
	Buffer.concat([Buffer.from([w >> 8, w & 255, h >> 8, h & 255]), jpeg]);

function rig(over: { unattended?: boolean; leaseHeld?: () => Promise<boolean> } = {}) {
	const runtime = new FakeBrowserRuntime([
		{ id: "p", url: "https://a.test/", title: "A", elements: [] },
	]);
	const control = new TaskControl(runtime, { pollMs: 10 });
	let frames: ((seq: number, payload: Buffer) => void) | undefined;
	let unsubscribed = 0;
	const stop = registerLiveTask({
		taskId: "task-1",
		userId: "owner",
		deviceId: "dev-1",
		runtime: runtime as unknown as LiveRuntime,
		control,
		subscribeFrames: (_device, listener) => {
			frames = listener;
			return () => {
				frames = undefined;
				unsubscribed += 1;
			};
		},
		timing: { ackEveryMs: 5, backedUpMs: 40, keepAliveMs: 30, leaseEveryMs: 20 },
		...over,
	});
	const viewer = (width = 480, accept = true) => {
		const events: LiveEvent[] = [];
		const v: LiveViewer = {
			width,
			send: (e) => {
				events.push(e);
				return accept;
			},
		};
		return { v, events };
	};
	return {
		runtime,
		control,
		stop,
		viewer,
		push: (seq: number, p = payload(1280, 800)) => frames?.(seq, p),
		isSubscribed: () => frames !== undefined,
		unsubscribed: () => unsubscribed,
	};
}

afterEach(() => vi.useRealTimers());

describe("the live view of a browse task", () => {
	it("is found only by its owner", () => {
		const r = rig();
		expect(liveTaskFor("task-1", "owner")).toBeDefined();
		expect(liveTaskFor("task-1", "somebody-else")).toBeUndefined();
		expect(liveTaskFor("other-task", "owner")).toBeUndefined();
		r.stop();
		expect(liveTaskFor("task-1", "owner")).toBeUndefined();
	});

	it("starts the screencast with the first viewer, sends frames on, and stops with the last", async () => {
		const r = rig();
		const task = must(liveTaskFor("task-1", "owner"));
		const a = r.viewer(320);
		const b = r.viewer(900);
		const leaveA = task.addViewer(a.v);
		expect(r.runtime.screencastCalls[0]).toEqual({ action: "start", width: 320 });
		const leaveB = task.addViewer(b.v);
		await vi.waitFor(() =>
			expect(r.runtime.screencastCalls.at(-1)).toEqual({ action: "start", width: 900 })
		);

		r.push(1);
		for (const viewer of [a, b]) {
			const frame = viewer.events.find((e) => e.type === "frame");
			expect(frame).toMatchObject({ type: "frame", seq: 1, width: 1280, height: 800 });
		}
		// A frame that is not one is dropped, not passed on.
		r.push(2, Buffer.from([0, 0, 0]));
		expect(a.events.filter((e) => e.type === "frame")).toHaveLength(1);

		leaveA();
		expect(r.isSubscribed()).toBe(true);
		leaveB();
		await vi.waitFor(() => expect(r.runtime.screencastCalls.at(-1)).toEqual({ action: "stop" }));
		expect(r.isSubscribed()).toBe(false);
		r.stop();
	});

	it("acks frames, paced, and later while a viewer is backed up", async () => {
		vi.useFakeTimers();
		const r = rig();
		const task = must(liveTaskFor("task-1", "owner"));
		const slow = r.viewer(480, false);
		task.addViewer(slow.v);
		r.push(1);
		r.push(2);
		r.push(3);
		await vi.advanceTimersByTimeAsync(10);
		// Backed up: no ack yet.
		expect(r.runtime.screencastCalls.filter((c) => c.action === "ack")).toEqual([]);
		await vi.advanceTimersByTimeAsync(60);
		// One ack, for the newest frame.
		expect(r.runtime.screencastCalls.filter((c) => c.action === "ack")).toEqual([
			{ action: "ack", seq: 3 },
		]);
		r.stop();
	});

	it("keeps the stream alive while watched", async () => {
		vi.useFakeTimers();
		const r = rig();
		const task = must(liveTaskFor("task-1", "owner"));
		task.addViewer(r.viewer(480).v);
		await vi.advanceTimersByTimeAsync(100);
		expect(r.runtime.screencastCalls.filter((c) => c.action === "start").length).toBeGreaterThan(2);
		r.stop();
	});

	it("tells the viewers and stops when the task ends or loses its machine", async () => {
		const r = rig({ leaseHeld: async () => false });
		const task = must(liveTaskFor("task-1", "owner"));
		const v = r.viewer();
		task.addViewer(v.v);
		await vi.waitFor(() => expect(v.events.at(-1)).toEqual({ type: "end", reason: "lease_lost" }));
		expect(liveTaskFor("task-1", "owner")).toBeUndefined();
		r.push(9);
		expect(v.events.filter((e) => e.type === "frame")).toEqual([]);
		await vi.waitFor(() => expect(r.runtime.screencastCalls.at(-1)).toEqual({ action: "stop" }));
	});

	it("tells a viewer who comes late that it is over", () => {
		const r = rig();
		const task = must(liveTaskFor("task-1", "owner"));
		r.stop();
		const v = r.viewer();
		task.addViewer(v.v);
		expect(v.events).toEqual([{ type: "end", reason: "ended" }]);
	});
});

describe("takeover and input", () => {
	it("pauses on takeover, tells the viewers, and takes input only then", async () => {
		const r = rig();
		const task = must(liveTaskFor("task-1", "owner"));
		const v = r.viewer();
		task.addViewer(v.v);
		const click = { events: [{ type: "mouse", action: "down", x: 10, y: 20, button: "left" }] };

		// Not in control: refused, nothing reaches the page.
		expect(await task.input(click)).toMatchObject({ ok: false, status: 409 });
		expect(r.runtime.userInput).toEqual([]);

		expect(await task.takeover()).toEqual({ ok: true, controller: "user" });
		expect(r.control.paused()).toBe(true);
		expect(v.events).toContainEqual({ type: "control", controller: "user" });
		expect(await task.input(click)).toEqual({ ok: true, sent: 1 });
		expect(r.runtime.userInput).toEqual(click.events);

		expect(await task.handBack()).toEqual({ ok: true, controller: "agent" });
		expect(v.events.at(-1)).toEqual({ type: "control", controller: "agent" });
		expect(await task.input(click)).toMatchObject({ ok: false, status: 409 });
		r.stop();
	});

	it("refuses to take over a scheduled run, and still lets its owner watch", async () => {
		const r = rig({ unattended: true });
		const task = must(liveTaskFor("task-1", "owner"));
		expect(await task.takeover()).toMatchObject({ ok: false, status: 403 });
		expect(r.control.paused()).toBe(false);
		const v = r.viewer();
		task.addViewer(v.v);
		expect(r.runtime.screencastCalls[0]).toMatchObject({ action: "start" });
		r.stop();
	});

	it("refuses an event that is not one", async () => {
		const r = rig();
		const task = must(liveTaskFor("task-1", "owner"));
		await task.takeover();
		for (const bad of [
			null,
			{},
			{ events: [] },
			{ events: [{ type: "eval", code: "1" }] },
			{ events: [{ type: "mouse", action: "move", x: -1, y: 0 }] },
			{ events: [{ type: "key", action: "down", key: "a" }] },
			{ events: Array.from({ length: 65 }, () => ({ type: "text", text: "a" })) },
		]) {
			expect(await task.input(bad)).toMatchObject({ ok: false, status: 400 });
		}
		expect(r.runtime.userInput).toEqual([]);
		r.stop();
	});

	it("rate limits input", async () => {
		const r = rig();
		const task = must(liveTaskFor("task-1", "owner"));
		await task.takeover();
		const one = { events: [{ type: "mouse", action: "move", x: 1, y: 1 }] };
		let refused = 0;
		for (let i = 0; i < 60; i += 1) {
			const result = await task.input(one);
			if (!result.ok && result.status === 429) refused += 1;
		}
		expect(refused).toBeGreaterThan(0);
		// And by events: one call of 64 moves, ten times over, is too much too.
		const big = {
			events: Array.from({ length: 64 }, () => ({ type: "mouse", action: "move", x: 1, y: 1 })),
		};
		const task2Result = await task.input(big);
		expect(task2Result).toMatchObject({ ok: false, status: 429 });
		r.stop();
	});

	it("says so when the machine's runtime is too old for takeover", async () => {
		const old = { control: undefined } as unknown as LiveRuntime;
		const control = new TaskControl(old);
		const stop = registerLiveTask({
			taskId: "old",
			userId: "owner",
			deviceId: "d",
			runtime: old,
			control,
		});
		const task = must(liveTaskFor("old", "owner"));
		expect(task.supported).toBe(false);
		expect(await task.takeover()).toMatchObject({ ok: false, status: 501 });
		stop();
	});
});
