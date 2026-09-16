import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { submitCodeExecutionResult } from "./codeExecution";
import type { CodeExecutionOutcome } from "$lib/types/ParkedCall";

const outcome: CodeExecutionOutcome = {
	ok: true,
	stdout: "hello\n",
	stderr: "",
	result: "'done'",
	files: [{ path: "/home/pyodide/out.csv", size: 120 }],
};

const parkRow = (over: Record<string, unknown> = {}) => ({
	_id: new ObjectId(),
	parkedCallId: "11111111-1111-4111-8111-111111111111",
	conversationId: new ObjectId(),
	messageId: "msg-1",
	toolCallId: "call-1",
	toolUuid: "uuid-1",
	kind: "code",
	status: "waiting",
	resumeAt: new Date(Date.now() + 60_000),
	reason: "code execution in the person's browser",
	code: "print('hi')",
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

describe("submitting a browser code execution outcome", () => {
	it("records the outcome, moves the deadline to now and asks for the resume", async () => {
		const row = parkRow();
		await collections.parkedCalls.insertOne(row as never);

		const result = await submitCodeExecutionResult({
			executionId: row.parkedCallId,
			conversationId: row.conversationId,
			outcome,
		});

		expect(result).toEqual({ ok: true, resume: true, messageId: "msg-1" });
		const stored = await collections.parkedCalls.findOne({ _id: row._id });
		// The deadline move is the entire state change: the row stays `waiting`
		// so the ordinary sweep claim decides which pod resumes the turn.
		expect(stored?.status).toBe("waiting");
		expect(stored?.outcome).toEqual(outcome);
		expect(stored?.resumeAt.getTime()).toBeLessThanOrEqual(Date.now());
	});

	it("records persisted deliverable references alongside the outcome", async () => {
		const row = parkRow();
		await collections.parkedCalls.insertOne(row as never);
		const withRefs: CodeExecutionOutcome = {
			...outcome,
			fileRefs: [{ name: "out.csv", size: 120, sha256: "a".repeat(64) }],
		};

		const result = await submitCodeExecutionResult({
			executionId: row.parkedCallId,
			conversationId: row.conversationId,
			outcome: withRefs,
		});

		expect(result.ok).toBe(true);
		const stored = await collections.parkedCalls.findOne({ _id: row._id });
		expect(stored?.outcome?.fileRefs).toEqual(withRefs.fileRefs);
	});

	it("refuses an unknown execution id", async () => {
		const result = await submitCodeExecutionResult({
			executionId: "22222222-2222-4222-8222-222222222222",
			conversationId: new ObjectId(),
			outcome,
		});
		expect(result).toEqual({ ok: false, status: 404, error: "Unknown code execution." });
	});

	it("refuses another conversation's execution id", async () => {
		const row = parkRow();
		await collections.parkedCalls.insertOne(row as never);
		const result = await submitCodeExecutionResult({
			executionId: row.parkedCallId,
			conversationId: new ObjectId(),
			outcome,
		});
		expect(result).toEqual({ ok: false, status: 404, error: "Unknown code execution." });
	});

	it("refuses a second, different answer", async () => {
		const row = parkRow();
		await collections.parkedCalls.insertOne(row as never);
		const first = await submitCodeExecutionResult({
			executionId: row.parkedCallId,
			conversationId: row.conversationId,
			outcome,
		});
		expect(first.ok).toBe(true);
		const second = await submitCodeExecutionResult({
			executionId: row.parkedCallId,
			conversationId: row.conversationId,
			outcome: { ...outcome, stdout: "tampered" },
		});
		expect(second).toEqual({ ok: false, status: 409, error: "Already answered." });
		const stored = await collections.parkedCalls.findOne({ _id: row._id });
		expect(stored?.outcome?.stdout).toBe("hello\n");
	});

	it("accepts a late answer the sweep has not claimed yet", async () => {
		const row = parkRow({ resumeAt: new Date(Date.now() - 1_000) });
		await collections.parkedCalls.insertOne(row as never);
		const result = await submitCodeExecutionResult({
			executionId: row.parkedCallId,
			conversationId: row.conversationId,
			outcome,
		});
		// The real result beats the sweeper's unavailable fallback: while the row
		// is still claimable, a late answer is accepted and wakes the row.
		expect(result.ok).toBe(true);
		const stored = await collections.parkedCalls.findOne({ _id: row._id });
		expect(stored?.outcome).toEqual(outcome);
		expect(stored?.resumeAt.getTime()).toBeLessThanOrEqual(Date.now());
	});

	it("refuses a row that is no longer waiting", async () => {
		const row = parkRow({ status: "resumed" });
		await collections.parkedCalls.insertOne(row as never);
		const result = await submitCodeExecutionResult({
			executionId: row.parkedCallId,
			conversationId: row.conversationId,
			outcome,
		});
		expect(result).toEqual({ ok: false, status: 409, error: "Already answered." });
	});
});
