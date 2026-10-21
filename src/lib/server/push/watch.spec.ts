import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { Envelope, NormalizedEvent } from "$lib/types/machineProtocol";
import { must } from "./testSupport";
import { LONG_TURN_MS } from "$lib/utils/pushEvents";
import { _resetWatchState, afterScheduleRun, chatTurnFinished, observeMachineEvent } from "./watch";

const me = new ObjectId();
let clock = 1_000_000;
const notify = vi.fn();
const firstCall = () => must(notify.mock.calls[0], "a notification");
const deps = { notify, now: () => clock };

function envelope(event: NormalizedEvent, sessionId = "s1", rootSessionId = sessionId): Envelope {
	return { sessionId, rootSessionId, epoch: "e", seq: 1, event };
}
const status = (s: "busy" | "idle" | "retry") => ({ kind: "status", status: s }) as NormalizedEvent;

beforeEach(() => {
	notify.mockReset();
	_resetWatchState();
	clock = 1_000_000;
});

describe("permission asks", () => {
	const asked = (id = "p1"): NormalizedEvent =>
		({ kind: "permission.asked", request: { id } }) as unknown as NormalizedEvent;

	it("notifies the machine's owner, with a path to the agent and no request content", () => {
		observeMachineEvent(me, "dev1", envelope(asked("p1"), "child", "root"), deps);
		expect(notify).toHaveBeenCalledOnce();
		const [user, event, msg] = firstCall();
		expect(user).toBe(me);
		expect(event).toBe("permission");
		expect(msg.path).toBe("/code?device=dev1&agent=root");
		expect(JSON.stringify(msg)).not.toMatch(/command|rm -rf|secret/);
	});

	it("tells a question the same way, and each ask once however often it is repeated", () => {
		const question = {
			kind: "question.asked",
			request: { id: "q1", questions: [{ question: "private?" }] },
		} as unknown as NormalizedEvent;
		observeMachineEvent(me, "dev1", envelope(question), deps);
		observeMachineEvent(me, "dev1", envelope(question), deps);
		observeMachineEvent(me, "dev1", envelope(asked("p1")), deps);
		observeMachineEvent(me, "dev1", envelope(asked("p1")), deps);
		expect(notify).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(notify.mock.calls)).not.toContain("private?");
	});
});

describe("a long agent turn", () => {
	it("notifies when a root session goes idle after a long turn", () => {
		observeMachineEvent(me, "dev1", envelope(status("busy")), deps);
		clock += LONG_TURN_MS + 1;
		observeMachineEvent(me, "dev1", envelope(status("idle")), deps);
		expect(notify).toHaveBeenCalledOnce();
		expect(firstCall()[1]).toBe("agentTurn");
		expect(firstCall()[2].title).toBe("An agent finished");
	});

	it("says it failed when an error came first, and counts a retry as the same turn", () => {
		observeMachineEvent(me, "dev1", envelope(status("busy")), deps);
		clock += 30_000;
		observeMachineEvent(me, "dev1", envelope(status("retry")), deps);
		clock += LONG_TURN_MS;
		observeMachineEvent(me, "dev1", envelope({ kind: "error", message: "x" }), deps);
		observeMachineEvent(me, "dev1", envelope(status("idle")), deps);
		expect(firstCall()[2].title).toBe("An agent stopped with an error");
	});

	it("is silent for a short turn, a subagent, or an idle with no turn seen", () => {
		observeMachineEvent(me, "dev1", envelope(status("busy")), deps);
		clock += LONG_TURN_MS - 1;
		observeMachineEvent(me, "dev1", envelope(status("idle")), deps);

		observeMachineEvent(me, "dev1", envelope(status("busy"), "child", "root"), deps);
		clock += LONG_TURN_MS * 2;
		observeMachineEvent(me, "dev1", envelope(status("idle"), "child", "root"), deps);

		observeMachineEvent(me, "dev1", envelope(status("idle"), "never-busy"), deps);
		expect(notify).not.toHaveBeenCalled();
	});

	it("keeps sessions on different machines apart", () => {
		observeMachineEvent(me, "dev1", envelope(status("busy")), deps);
		clock += LONG_TURN_MS + 1;
		observeMachineEvent(me, "dev2", envelope(status("idle")), deps);
		expect(notify).not.toHaveBeenCalled();
	});

	it("ignores token deltas cheaply", () => {
		const delta = {
			kind: "delta",
			messageId: "m",
			partId: "p",
			role: "assistant",
			field: "text",
			delta: "x",
		} as NormalizedEvent;
		observeMachineEvent(me, "dev1", envelope(delta), deps);
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("a background task failing", () => {
	const part = (state: string): NormalizedEvent =>
		({
			kind: "part",
			part: {
				type: "text",
				synthetic: true,
				text: `<task id="t1" state="${state}"><summary>x</summary><task_error>stack trace</task_error></task>`,
			},
		}) as unknown as NormalizedEvent;

	it("notifies once for an errored task, without its text", () => {
		observeMachineEvent(me, "dev1", envelope(part("error")), deps);
		observeMachineEvent(me, "dev1", envelope(part("error")), deps);
		expect(notify).toHaveBeenCalledOnce();
		expect(firstCall()[1]).toBe("backgroundTask");
		expect(JSON.stringify(notify.mock.calls)).not.toContain("stack trace");
	});

	it("is silent for a completed or running task, and for prose that quotes the tags", () => {
		observeMachineEvent(me, "dev1", envelope(part("completed")), deps);
		observeMachineEvent(me, "dev1", envelope(part("running")), deps);
		const prose = {
			kind: "part",
			part: { type: "text", text: '<task id="t9" state="error"></task>' },
		} as unknown as NormalizedEvent;
		observeMachineEvent(me, "dev1", envelope(prose), deps);
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("a scheduled run", () => {
	const sent = (userId = me) => ({
		status: "sent" as const,
		userId,
		scheduleName: "Nightly report",
		scheduleId: new ObjectId(),
		result: { type: "agent-session", ids: { deviceId: "dev1", workspaceId: "w", sessionId: "s1" } },
	});

	it("tells the end of the run's turn, short or long, to the schedule's owner", () => {
		afterScheduleRun(sent(), deps);
		expect(notify).not.toHaveBeenCalled(); // dispatching is not finishing
		observeMachineEvent(me, "dev1", envelope(status("busy")), deps);
		clock += 5_000; // a short turn still counts
		observeMachineEvent(me, "dev1", envelope(status("idle")), deps);
		expect(notify).toHaveBeenCalledOnce();
		expect(firstCall()[1]).toBe("scheduleRun");
		expect(firstCall()[2].title).toBe("Scheduled run finished");
		// One notification for one thing: not also an agentTurn, and not again.
		observeMachineEvent(me, "dev1", envelope(status("busy")), deps);
		clock += LONG_TURN_MS + 1;
		observeMachineEvent(me, "dev1", envelope(status("idle")), deps);
		expect(notify.mock.calls.map((c) => c[1])).toEqual(["scheduleRun", "agentTurn"]);
	});

	it("tells a failed turn as a failed run", () => {
		afterScheduleRun(sent(), deps);
		observeMachineEvent(me, "dev1", envelope(status("busy")), deps);
		observeMachineEvent(me, "dev1", envelope({ kind: "error", message: "boom" }), deps);
		observeMachineEvent(me, "dev1", envelope(status("idle")), deps);
		expect(firstCall()[2].title).toBe("Scheduled run failed");
	});

	it("tells a run that could not be dispatched at once, and skips the quiet statuses", () => {
		const base = { ...sent(), result: undefined };
		afterScheduleRun({ ...base, status: "failed" }, deps);
		afterScheduleRun({ ...base, status: "missed-offline" }, deps);
		afterScheduleRun({ ...base, status: "skipped-still-running" }, deps);
		afterScheduleRun({ ...base, status: "missed-downtime" }, deps);
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify.mock.calls.every((c) => c[1] === "scheduleRun")).toBe(true);
		expect(firstCall()[2].path).toBe("/code?view=schedules");
	});
});

describe("a chat turn", () => {
	const ended = (over: Partial<Parameters<typeof chatTurnFinished>[0]> = {}) =>
		chatTurnFinished(
			{
				userId: me,
				conversationId: new ObjectId(),
				startedAt: clock,
				status: "completed",
				...over,
			},
			deps
		);

	it("notifies for a long completed turn only", () => {
		clock += LONG_TURN_MS + 1;
		ended({ startedAt: clock - LONG_TURN_MS - 1 });
		expect(notify).toHaveBeenCalledOnce();
		expect(firstCall()[1]).toBe("chatTurn");
		expect(firstCall()[2].path).toMatch(/^\/conversation\/[0-9a-f]{24}$/);

		notify.mockReset();
		ended({ startedAt: clock - 1000 });
		ended({ startedAt: clock - LONG_TURN_MS - 1, status: "error" });
		ended({ startedAt: clock - LONG_TURN_MS - 1, status: "interrupted" });
		ended({ startedAt: clock - LONG_TURN_MS - 1, userId: undefined });
		expect(notify).not.toHaveBeenCalled();
	});
});
