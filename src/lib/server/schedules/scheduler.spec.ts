import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import type { ExecutorOutcome, ExecutorRunContext } from "./executors";

const limits = vi.hoisted(() => ({ enabled: true, cap: 20 }));
vi.mock("./limits", async (original) => ({
	...(await original<typeof import("./limits")>()),
	schedulesEnabled: () => limits.enabled,
	maxSchedulesPerUser: () => limits.cap,
}));

import { _clearExecutors, getExecutor, registerExecutor } from "./executors";
import {
	CATCH_UP_CAP_MS,
	claimDue,
	decideLateness,
	fireClaim,
	LEASE_MS,
	runDue,
	runNow,
} from "./scheduler";
import {
	ScheduleError,
	createSchedule,
	deleteSchedule,
	getSchedule,
	listRuns,
	updateSchedule,
} from "./store";
import type { Schedule } from "$lib/types/Schedule";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The stub executor: records what the core handed it, answers what the test says. */
const calls: ExecutorRunContext[] = [];
let answer: (context: ExecutorRunContext) => ExecutorOutcome | Promise<ExecutorOutcome>;
let kindAvailable = true;

function installStub() {
	_clearExecutors();
	registerExecutor({
		kind: "agent",
		available: () => kindAvailable,
		validateTarget: async (target) => {
			const t = target as { ok?: boolean } | null;
			return t && t.ok === false
				? { ok: false, error: "That target is not yours." }
				: { ok: true, target: { stub: true } };
		},
		describeTarget: async () => "stub › target",
		run: async (context) => {
			calls.push(context);
			return answer(context);
		},
	});
}

const base = {
	name: "Nightly",
	prompt: "do the thing",
	target: {},
	recurrence: { type: "hours", every: 4 },
	timezone: "UTC",
};

let user: ObjectId;

async function due(overrides: Partial<Schedule> & { scheduledFor?: Date } = {}): Promise<Schedule> {
	const schedule = await createSchedule(user, base);
	const { scheduledFor, ...rest } = overrides;
	const nextRunAt = scheduledFor ?? new Date(Date.now() - MIN);
	await collections.schedules.updateOne(
		{ _id: schedule._id },
		// Counted from the occurrence itself, so "every 4 hours" is a 4 hour interval.
		{ $set: { nextRunAt, anchorAt: nextRunAt, ...rest } }
	);
	return (await collections.schedules.findOne({ _id: schedule._id })) as Schedule;
}

beforeAll(async () => {
	await ready;
});

beforeEach(() => {
	user = new ObjectId();
	limits.enabled = true;
	limits.cap = 20;
	kindAvailable = true;
	calls.length = 0;
	answer = () => ({ status: "sent", detail: "ok" });
	installStub();
});

afterEach(async () => {
	await collections.schedules.deleteMany({});
	await collections.scheduleRuns.deleteMany({});
});

describe("the claim lease", () => {
	it("lets exactly one of two concurrent claimers have a due schedule", async () => {
		for (let round = 0; round < 8; round++) {
			await due();
			const now = new Date();
			const [a, b] = await Promise.all([claimDue(now, "instance-a"), claimDue(now, "instance-b")]);
			expect([a, b].filter(Boolean)).toHaveLength(1);
			await collections.schedules.deleteMany({});
		}
	});

	it("advances nextRunAt past now before anything runs", async () => {
		const row = await due();
		const now = new Date();
		const claim = await claimDue(now, "a");
		expect(claim?.scheduledFor.getTime()).toBe(row.nextRunAt?.getTime());
		const stored = await collections.schedules.findOne({ _id: row._id });
		expect(stored?.nextRunAt?.getTime()).toBeGreaterThan(now.getTime());
		expect(stored?.leaseOwner).toBe("a");
		expect(calls).toHaveLength(0);
	});

	it("leaves a leased schedule alone, and takes it again once the lease has lapsed", async () => {
		const row = await due();
		expect(await claimDue(new Date(), "a")).not.toBeNull();
		// Due again while a's lease is still in force: nobody else may take it.
		await collections.schedules.updateOne(
			{ _id: row._id },
			{ $set: { nextRunAt: new Date(Date.now() - MIN) } }
		);
		expect(await claimDue(new Date(), "b")).toBeNull();
		expect(await claimDue(new Date(Date.now() + LEASE_MS + MIN), "b")).not.toBeNull();
	});

	it("ignores a disabled schedule and a kind with no available executor", async () => {
		await due({ enabled: false });
		expect(await claimDue(new Date(), "a")).toBeNull();
		await due();
		kindAvailable = false;
		expect(await claimDue(new Date(), "a")).toBeNull();
		expect(await runDue()).toBe(0);
	});
});

describe("running", () => {
	it("hands the executor the occurrence and records a sent run", async () => {
		const row = await due();
		expect(await runDue()).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0].scheduledFor.getTime()).toBe(row.nextRunAt?.getTime());
		expect(calls[0].trigger).toBe("schedule");
		const runs = await listRuns(user, row._id.toString());
		expect(runs.map((r) => r.status)).toEqual(["sent"]);
		const stored = await collections.schedules.findOne({ _id: row._id });
		expect(stored?.lastStatus).toBe("sent");
		expect(stored?.leaseUntil).toBeNull();
	});

	it("records a run that threw as failed, with the reason", async () => {
		answer = () => {
			throw new Error("boom");
		};
		const row = await due();
		await runDue();
		const [run] = await listRuns(user, row._id.toString());
		expect(run.status).toBe("failed");
		expect(run.detail).toBe("boom");
	});

	it("records, but does not fire, a schedule whose kind has no executor", async () => {
		const row = await due();
		_clearExecutors();
		const claim = await claimDue(new Date(), "a", ["agent"]);
		if (!claim) throw new Error("claim");
		const run = await fireClaim(claim, new Date(), "a");
		if (!run) throw new Error("run");
		expect(run.status).toBe("failed");
		expect(run.detail).toMatch(/Nothing here can run/);
		expect(row).toBeTruthy();
	});
});

describe("overlap", () => {
	it("passes the executor the last sent run, so it can tell its output is still busy", async () => {
		const row = await due();
		answer = () => ({
			status: "sent",
			result: { type: "agent-session", ids: { sessionId: "s1" } },
		});
		await runNow(user, row._id.toString());
		answer = (context) =>
			context.previousRun?.result?.ids.sessionId === "s1"
				? { status: "skipped-still-running", detail: "s1 is still working" }
				: { status: "sent" };
		const run = await runNow(user, row._id.toString());
		expect(run.status).toBe("skipped-still-running");
		const stored = await collections.schedules.findOne({ _id: row._id });
		expect(stored?.lastStatus).toBe("skipped-still-running");
		expect(stored?.consecutiveFailures).toBe(0);
		expect(await collections.scheduleRuns.countDocuments({ scheduleId: row._id })).toBe(2);
	});
});

describe("downtime: one catch-up, or missed-downtime", () => {
	// every 4 hours: half the interval is 2 hours, but the window is capped at 1.
	it("fires a single catch-up when under half the interval late", async () => {
		const row = await due({ scheduledFor: new Date(Date.now() - 45 * MIN) });
		await runDue();
		expect(calls).toHaveLength(1);
		const [run] = await listRuns(user, row._id.toString());
		expect(run.status).toBe("sent");
		expect(run.detail).toMatch(/Catch-up: 45 min late/);
		const stored = await collections.schedules.findOne({ _id: row._id });
		// The occurrences in between are not replayed.
		expect(stored?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
		expect(await runDue()).toBe(0);
	});

	it("gives up an occurrence that is later than the window, with nothing replayed after it", async () => {
		const row = await due({ scheduledFor: new Date(Date.now() - 3 * HOUR) });
		await runDue();
		expect(calls).toHaveLength(0);
		const runs = await listRuns(user, row._id.toString());
		expect(runs.map((r) => r.status)).toEqual(["missed-downtime"]);
		expect(runs[0].detail).toMatch(/not running/);
		const stored = await collections.schedules.findOne({ _id: row._id });
		expect(stored?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
		expect(stored?.consecutiveFailures).toBe(0);
		expect(await runDue()).toBe(0);
	});

	it("uses half the interval for a short one", async () => {
		const hourly = { recurrence: { type: "hours" as const, every: 1 } };
		const recent = await due({ scheduledFor: new Date(Date.now() - 20 * MIN), ...hourly });
		await runDue();
		expect(calls).toHaveLength(1);
		const late = await due({ scheduledFor: new Date(Date.now() - 40 * MIN), ...hourly });
		await runDue();
		expect(calls).toHaveLength(1);
		expect((await listRuns(user, recent._id.toString()))[0].status).toBe("sent");
		expect((await listRuns(user, late._id.toString()))[0].status).toBe("missed-downtime");
	});

	it("caps the catch-up window at an hour however long the interval", () => {
		const daily = { recurrence: { type: "daily", at: "09:00" }, timezone: "UTC" } as Schedule;
		daily.anchorAt = new Date("2026-01-01T00:00:00Z");
		const scheduledFor = new Date("2026-01-05T09:00:00Z");
		const at = (late: number) => new Date(scheduledFor.getTime() + late);
		expect(decideLateness(daily, scheduledFor, at(CATCH_UP_CAP_MS - MIN)).fire).toBe(true);
		expect(decideLateness(daily, scheduledFor, at(CATCH_UP_CAP_MS + MIN)).fire).toBe(false);
	});

	it("treats an ordinary late tick as on time", () => {
		const hourly = { recurrence: { type: "hours", every: 1 }, timezone: "UTC" } as Schedule;
		hourly.anchorAt = new Date("2026-01-01T00:00:00Z");
		const scheduledFor = new Date("2026-01-01T05:00:00Z");
		expect(decideLateness(hourly, scheduledFor, new Date(scheduledFor.getTime() + 40_000))).toEqual(
			{ fire: true }
		);
	});
});

describe("failures", () => {
	it("disables the schedule after three failed runs in a row, with the reason", async () => {
		answer = () => ({ status: "failed", detail: "The workspace is gone." });
		const row = await due();
		const id = row._id.toString();
		await runNow(user, id);
		await runNow(user, id);
		expect((await getSchedule(user, id)).enabled).toBe(true);
		await runNow(user, id);
		const stored = await getSchedule(user, id);
		expect(stored.enabled).toBe(false);
		expect(stored.nextRunAt).toBeNull();
		expect(stored.disabledReason).toMatch(/3 failed runs in a row.*The workspace is gone/);
	});

	it("counts only consecutive failures: a sent run starts the count again", async () => {
		const row = await due();
		const id = row._id.toString();
		answer = () => ({ status: "failed", detail: "x" });
		await runNow(user, id);
		await runNow(user, id);
		answer = () => ({ status: "sent" });
		await runNow(user, id);
		answer = () => ({ status: "failed", detail: "x" });
		await runNow(user, id);
		await runNow(user, id);
		expect((await getSchedule(user, id)).enabled).toBe(true);
	});

	it("switches off at once when the executor says to", async () => {
		answer = () => ({ status: "failed", detail: "revoked", disable: "The machine was revoked." });
		const row = await due();
		await runNow(user, row._id.toString());
		const stored = await getSchedule(user, row._id.toString());
		expect(stored.enabled).toBe(false);
		expect(stored.disabledReason).toBe("The machine was revoked.");
	});

	it("starts afresh when the person switches it back on", async () => {
		answer = () => ({ status: "failed", detail: "x", disable: "off" });
		const row = await due();
		const id = row._id.toString();
		await runNow(user, id);
		const revived = await updateSchedule(user, id, { enabled: true });
		expect(revived.enabled).toBe(true);
		expect(revived.disabledReason).toBeUndefined();
		expect(revived.consecutiveFailures).toBe(0);
		expect(revived.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
	});
});

describe("run now", () => {
	it("does not move nextRunAt, and records a manual run", async () => {
		const row = await createSchedule(user, base);
		const run = await runNow(user, row._id.toString());
		expect(run.trigger).toBe("manual");
		const stored = await collections.schedules.findOne({ _id: row._id });
		expect(stored?.nextRunAt?.getTime()).toBe(row.nextRunAt?.getTime());
	});

	it("refuses while a run of the same schedule holds the lease", async () => {
		const row = await createSchedule(user, base);
		await collections.schedules.updateOne(
			{ _id: row._id },
			{ $set: { leaseUntil: new Date(Date.now() + MIN), leaseOwner: "someone" } }
		);
		await expect(runNow(user, row._id.toString())).rejects.toMatchObject({ status: 409 });
		expect(calls).toHaveLength(0);
	});

	it("is the owner's alone", async () => {
		const row = await createSchedule(user, base);
		await expect(runNow(new ObjectId(), row._id.toString())).rejects.toMatchObject({
			status: 404,
		});
		await expect(runNow(user, "not-an-id")).rejects.toMatchObject({ status: 404 });
	});
});

describe("the kill switch", () => {
	it("stops the loop and refuses run-now, and nothing is deleted", async () => {
		const row = await due();
		limits.enabled = false;
		expect(await runDue()).toBe(0);
		await expect(runNow(user, row._id.toString())).rejects.toMatchObject({ status: 404 });
		expect(calls).toHaveLength(0);
		expect(await collections.schedules.countDocuments({ _id: row._id })).toBe(1);
		limits.enabled = true;
		// What came due while it was off is judged by the downtime rules, not replayed.
		expect(await runDue()).toBe(1);
	});
});

describe("the per-user cap", () => {
	it("refuses the schedule past the cap, and not another person's", async () => {
		limits.cap = 2;
		await createSchedule(user, base);
		await createSchedule(user, base);
		await expect(createSchedule(user, base)).rejects.toMatchObject({
			status: 409,
			message: expect.stringMatching(/at most 2/),
		});
		await createSchedule(new ObjectId(), base);
	});

	it("holds when creates race", async () => {
		limits.cap = 3;
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, () => createSchedule(user, base))
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
		expect(await collections.schedules.countDocuments({ userId: user })).toBe(3);
	});
});

describe("the executor registry", () => {
	it("refuses a kind nothing is registered for", async () => {
		_clearExecutors();
		expect(getExecutor("chat")).toBeNull();
		await expect(createSchedule(user, { ...base, kind: "chat" })).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(/Nothing here can run "chat"/),
		});
		await expect(createSchedule(user, { ...base, kind: "bogus" })).rejects.toBeInstanceOf(
			ScheduleError
		);
	});

	it("takes a second kind with no change to the core", async () => {
		const seen: string[] = [];
		registerExecutor({
			kind: "chat",
			validateTarget: async () => ({ ok: true, target: { conversation: "c1" } }),
			describeTarget: async () => "a chat",
			run: async ({ schedule }) => {
				seen.push(schedule.kind);
				return { status: "sent" };
			},
		});
		const row = await createSchedule(user, { ...base, kind: "chat" });
		await runNow(user, row._id.toString());
		expect(seen).toEqual(["chat"]);
	});

	it("lets the executor refuse a target, and stores what it normalised", async () => {
		await expect(createSchedule(user, { ...base, target: { ok: false } })).rejects.toMatchObject({
			status: 400,
			message: "That target is not yours.",
		});
		const row = await createSchedule(user, base);
		expect(row.target).toEqual({ stub: true });
	});
});

describe("max occurrences: the stopping criterion", () => {
	/** Make the row due again, anchored at the occurrence itself. */
	async function dueAgain(id: ObjectId) {
		const at = new Date(Date.now() - MIN);
		await collections.schedules.updateOne({ _id: id }, { $set: { nextRunAt: at, anchorAt: at } });
	}

	it("stops after the last scheduled fire, switched off with the reason", async () => {
		const row = await due({ maxOccurrences: 2 });
		const id = row._id.toString();
		await runDue();
		expect(calls).toHaveLength(1);
		expect((await getSchedule(user, id)).enabled).toBe(true);
		await dueAgain(row._id);
		await runDue();
		expect(calls).toHaveLength(2);
		const stored = await getSchedule(user, id);
		expect(stored.enabled).toBe(false);
		expect(stored.nextRunAt).toBeNull();
		expect(stored.firedCount).toBe(2);
		expect(stored.disabledReason).toBe("Ran its 2 scheduled occurrences and switched off.");
		expect(await listRuns(user, id)).toHaveLength(2);
		// Switched off, nothing further runs however often it is made due.
		await dueAgain(row._id);
		expect(await runDue()).toBe(0);
		expect(calls).toHaveLength(2);
	});

	it("does not count a manual run", async () => {
		const row = await due({ maxOccurrences: 2 });
		const id = row._id.toString();
		await runNow(user, id);
		let stored = await getSchedule(user, id);
		expect(stored.firedCount).toBe(0);
		expect(stored.enabled).toBe(true);
		await dueAgain(row._id);
		await runDue();
		stored = await getSchedule(user, id);
		expect(stored.firedCount).toBe(1);
		expect(stored.enabled).toBe(true);
		expect(calls).toHaveLength(2);
	});

	it("counts a failed fire but neither a skip nor a miss", async () => {
		answer = () => ({ status: "skipped-still-running", detail: "still going" });
		const row = await due({ maxOccurrences: 2 });
		const id = row._id.toString();
		await runDue();
		expect((await getSchedule(user, id)).firedCount).toBe(0);
		answer = () => ({ status: "failed", detail: "no" });
		await dueAgain(row._id);
		await runDue();
		expect((await getSchedule(user, id)).firedCount).toBe(1);
		// A missed occurrence is not a fire either.
		const late = new Date(Date.now() - 3 * HOUR);
		await collections.schedules.updateOne(
			{ _id: row._id },
			{ $set: { nextRunAt: late, anchorAt: late } }
		);
		await runDue();
		expect((await getSchedule(user, id)).firedCount).toBe(1);
		answer = () => ({ status: "sent" });
		await dueAgain(row._id);
		await runDue();
		const stored = await getSchedule(user, id);
		expect(stored.firedCount).toBe(2);
		expect(stored.enabled).toBe(false);
		expect(stored.disabledReason).toBe("Ran its 2 scheduled occurrences and switched off.");
	});

	it("disables at once when the cap is edited below the count already reached", async () => {
		const row = await due({ maxOccurrences: 5 });
		const id = row._id.toString();
		await runDue();
		expect(await collections.scheduleRuns.countDocuments({ scheduleId: row._id })).toBe(1);
		const edited = await updateSchedule(user, id, { maxOccurrences: 1 });
		expect(edited.enabled).toBe(false);
		expect(edited.nextRunAt).toBeNull();
		expect(edited.disabledReason).toBe("Ran its 1 scheduled occurrences and switched off.");
		// Switched off without firing, and without a run row.
		expect(await collections.scheduleRuns.countDocuments({ scheduleId: row._id })).toBe(1);
		expect(await runDue()).toBe(0);
		expect(calls).toHaveLength(1);
	});

	it("does not fire a claim whose row is already at its cap, and records nothing", async () => {
		const row = await due({ maxOccurrences: 2 });
		// A cap that reached below the count without going through the store.
		await collections.schedules.updateOne({ _id: row._id }, { $set: { firedCount: 3 } });
		expect(await runDue()).toBe(1);
		expect(calls).toHaveLength(0);
		const stored = await getSchedule(user, row._id.toString());
		expect(stored.enabled).toBe(false);
		expect(stored.nextRunAt).toBeNull();
		expect(stored.disabledReason).toBe("Ran its 2 scheduled occurrences and switched off.");
		expect(await collections.scheduleRuns.countDocuments({ scheduleId: row._id })).toBe(0);
	});

	it("re-opens the schedule when the cap is cleared", async () => {
		const row = await due({ maxOccurrences: 1 });
		const id = row._id.toString();
		await runDue();
		expect((await getSchedule(user, id)).enabled).toBe(false);
		const cleared = await updateSchedule(user, id, { maxOccurrences: null });
		expect(cleared.maxOccurrences).toBeUndefined();
		expect(cleared.enabled).toBe(false);
		const revived = await updateSchedule(user, id, { enabled: true });
		expect(revived.enabled).toBe(true);
		expect(revived.disabledReason).toBeUndefined();
		expect(revived.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
		await dueAgain(row._id);
		await runDue();
		const stored = await getSchedule(user, id);
		expect(stored.enabled).toBe(true);
		expect(stored.firedCount).toBe(2);
	});

	it("re-enabling a schedule still at its cap switches it off again at once", async () => {
		const row = await due({ maxOccurrences: 1 });
		const id = row._id.toString();
		await runDue();
		const revived = await updateSchedule(user, id, { enabled: true });
		expect(revived.enabled).toBe(false);
		expect(revived.disabledReason).toBe("Ran its 1 scheduled occurrences and switched off.");
		expect(calls).toHaveLength(1);
	});

	it("reads a missing counter as zero on rows from before the field", async () => {
		const row = await due({ maxOccurrences: 1 });
		await collections.schedules.updateOne({ _id: row._id }, { $unset: { firedCount: "" } });
		await runDue();
		const stored = await getSchedule(user, row._id.toString());
		expect(stored.firedCount).toBe(1);
		expect(stored.enabled).toBe(false);
	});
});

describe("validation and ownership", () => {
	it("refuses a bad recurrence, zone, name and prompt", async () => {
		const cases: Array<Record<string, unknown>> = [
			{ recurrence: { type: "cron", expr: "*/5 * * * *" } },
			{ timezone: "Mars/Base" },
			{ name: "   " },
			{ prompt: "" },
			{ prompt: "x".repeat(8001) },
		];
		for (const change of cases) {
			await expect(createSchedule(user, { ...base, ...change })).rejects.toMatchObject({
				status: 400,
			});
		}
	});

	it("keeps one person's schedules from another", async () => {
		const mine = await createSchedule(user, base);
		const stranger = new ObjectId();
		const id = mine._id.toString();
		await expect(getSchedule(stranger, id)).rejects.toMatchObject({ status: 404 });
		await expect(updateSchedule(stranger, id, { name: "x" })).rejects.toMatchObject({
			status: 404,
		});
		await expect(deleteSchedule(stranger, id)).rejects.toMatchObject({ status: 404 });
		expect(await listRuns(stranger, id)).toEqual([]);
		expect(await collections.schedules.countDocuments({ _id: mine._id })).toBe(1);
	});

	it("recomputes the next run when the timetable changes, and clears it when disabled", async () => {
		const row = await createSchedule(user, base);
		const id = row._id.toString();
		const daily = await updateSchedule(user, id, {
			recurrence: { type: "daily", at: "09:00" },
			timezone: "Europe/Rome",
		});
		expect(daily.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
		expect(daily.nextRunAt?.getTime()).not.toBe(row.nextRunAt?.getTime());
		const off = await updateSchedule(user, id, { enabled: false });
		expect(off.nextRunAt).toBeNull();
	});

	it("keeps the run rows when the schedule is deleted", async () => {
		const row = await createSchedule(user, base);
		await runNow(user, row._id.toString());
		await deleteSchedule(user, row._id.toString());
		expect(await collections.scheduleRuns.countDocuments({ scheduleId: row._id })).toBe(1);
	});

	it("validates the stopping criterion: absent or a whole 1..100000, nothing else", async () => {
		for (const bad of [0, -1, "3", 100001, 1.5]) {
			await expect(createSchedule(user, { ...base, maxOccurrences: bad })).rejects.toMatchObject({
				status: 400,
			});
		}
		const row = await createSchedule(user, { ...base, maxOccurrences: 5 });
		expect(row.maxOccurrences).toBe(5);
		const edited = await updateSchedule(user, row._id.toString(), { maxOccurrences: 2 });
		expect(edited.maxOccurrences).toBe(2);
		for (const bad of [0, -1, "3", 100001]) {
			await expect(
				updateSchedule(user, row._id.toString(), { maxOccurrences: bad })
			).rejects.toMatchObject({ status: 400 });
			await expect(createSchedule(user, { ...base, maxOccurrences: bad })).rejects.toMatchObject({
				status: 400,
			});
		}
		// `null` is how the cap is cleared, on either path.
		expect(
			(await updateSchedule(user, row._id.toString(), { maxOccurrences: null })).maxOccurrences
		).toBeUndefined();
		expect(
			(await createSchedule(user, { ...base, maxOccurrences: null })).maxOccurrences
		).toBeUndefined();
	});
});
