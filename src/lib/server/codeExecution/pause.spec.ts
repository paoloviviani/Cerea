import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { sweepParkedCalls } from "$lib/server/generation/parkedSweeper";
import { extendCodeDeadlineForPause } from "./browserBackend";
import { codePausedWaitMs, DEFAULT_CODE_PAUSED_WAIT_MS } from "./deadlines";
import type { ParkedCall } from "$lib/types/ParkedCall";

const ID = "33333333-3333-4333-8333-333333333333";

const row = (over: Partial<ParkedCall> = {}): ParkedCall => ({
	_id: new ObjectId(),
	parkedCallId: ID,
	conversationId: new ObjectId(),
	messageId: "msg-1",
	toolCallId: "call-1",
	toolUuid: "uuid-1",
	kind: "code",
	status: "waiting",
	resumeAt: new Date(Date.now() + 5_000),
	reason: "code execution in the person's browser",
	code: "print(1)",
	attempts: 0,
	createdAt: new Date(),
	updatedAt: new Date(),
	...over,
});

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	await collections.parkedCalls.deleteMany({});
});

describe("extendCodeDeadlineForPause", () => {
	it("moves the deadline out to the paused wait and records the first pause", async () => {
		const r = row();
		await collections.parkedCalls.insertOne(r);
		const now = new Date();

		const res = await extendCodeDeadlineForPause(r.conversationId, ID, now);

		expect(res.ok).toBe(true);
		const stored = await collections.parkedCalls.findOne({ _id: r._id });
		expect(stored?.resumeAt.getTime()).toBe(now.getTime() + codePausedWaitMs());
		expect(stored?.pausedAt?.getTime()).toBe(now.getTime());
		expect(stored?.status).toBe("waiting");
	});

	it("never shortens a deadline that is already further out", async () => {
		const far = new Date(Date.now() + 3 * 60 * 60_000);
		const r = row({ resumeAt: far });
		await collections.parkedCalls.insertOne(r);

		await extendCodeDeadlineForPause(r.conversationId, ID);

		expect((await collections.parkedCalls.findOne({ _id: r._id }))?.resumeAt.getTime()).toBe(
			far.getTime()
		);
	});

	it("caps repeated signals at the wait counted from the first pause", async () => {
		const r = row();
		await collections.parkedCalls.insertOne(r);
		const first = new Date();
		await extendCodeDeadlineForPause(r.conversationId, ID, first);

		// A signal ten minutes later extends, but only up to first + wait.
		await extendCodeDeadlineForPause(r.conversationId, ID, new Date(first.getTime() + 10 * 60_000));
		let stored = await collections.parkedCalls.findOne({ _id: r._id });
		expect(stored?.resumeAt.getTime()).toBe(first.getTime() + codePausedWaitMs());

		await extendCodeDeadlineForPause(r.conversationId, ID, new Date(first.getTime() + 40 * 60_000));
		stored = await collections.parkedCalls.findOne({ _id: r._id });
		expect(stored?.resumeAt.getTime()).toBe(first.getTime() + codePausedWaitMs());
		expect(stored?.pausedAt?.getTime()).toBe(first.getTime());
	});

	it("only touches a pending code call of that conversation", async () => {
		const r = row();
		const answered = row({
			_id: new ObjectId(),
			parkedCallId: "44444444-4444-4444-8444-444444444444",
			conversationId: r.conversationId,
			outcome: { ok: true, stdout: "", stderr: "", files: [] },
		});
		const timer = row({
			_id: new ObjectId(),
			parkedCallId: "55555555-5555-4555-8555-555555555555",
			conversationId: r.conversationId,
			kind: "timer",
		});
		await collections.parkedCalls.insertMany([r, answered, timer]);

		expect(await extendCodeDeadlineForPause(new ObjectId(), ID)).toMatchObject({
			ok: false,
			status: 404,
		});
		expect(await extendCodeDeadlineForPause(r.conversationId, answered.parkedCallId)).toMatchObject(
			{ ok: false, status: 409 }
		);
		expect(await extendCodeDeadlineForPause(r.conversationId, timer.parkedCallId)).toMatchObject({
			ok: false,
			status: 404,
		});
	});
});

describe("the sweeper and a paused call", () => {
	it("keeps waiting while the extended deadline holds and expires the row after it", async () => {
		const r = row({ resumeAt: new Date(Date.now() - 1_000) });
		await collections.parkedCalls.insertOne(r);

		// The original deadline already passed, but the pause signal got there first.
		await extendCodeDeadlineForPause(r.conversationId, ID);
		await sweepParkedCalls();
		expect((await collections.parkedCalls.findOne({ _id: r._id }))?.status).toBe("waiting");

		// Past the extended deadline the sweeper takes the row (here: no conversation to resume).
		await collections.parkedCalls.updateOne(
			{ _id: r._id },
			{ $set: { resumeAt: new Date(Date.now() - 1_000) } }
		);
		await sweepParkedCalls();
		expect((await collections.parkedCalls.findOne({ _id: r._id }))?.status).toBe("abandoned");
	});
});

describe("codePausedWaitMs", () => {
	it("defaults to fifteen minutes", () => {
		expect(codePausedWaitMs()).toBe(DEFAULT_CODE_PAUSED_WAIT_MS);
	});
});
