/**
 * C155: a turn resumes once, and only when every call of its round is in.
 *
 * The incident (2026-11-19): one round held a slow MCP call (running inside the
 * producing run) and an `execute_code` call (parked on the browser). The
 * browser answered in seconds; the sweeper resumed the turn at once, while the
 * first run was still waiting for the MCP call. The resumed turn ran without
 * that call's result, and the overtaken run's late write was dropped (#301).
 *
 * Real Mongo; `textGeneration` is a probe that records each resume and what the
 * turn looked like when it happened.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const seen = vi.hoisted(() => ({
	resumes: [] as { updates: { uuid?: string; subtype?: string }[] }[],
}));

vi.mock("$lib/server/textGeneration", () => ({
	async *textGeneration(ctx: {
		conv: { messages: { id: string; updates?: { uuid?: string; subtype?: string }[] }[] };
		messageId: string;
	}) {
		const message = ctx.conv.messages.find((m) => m.id === ctx.messageId);
		seen.resumes.push({ updates: [...(message?.updates ?? [])] });
	},
}));

vi.mock("$lib/server/models", () => ({
	models: [{ id: "test/model", name: "test/model", parameters: {}, getEndpoint: async () => ({}) }],
}));

import { collections, ready } from "$lib/server/database";
import { endRoundOnStop, sweepParkedCalls } from "./parkedSweeper";
import { backfillApprovalResumes, deferDelayMs, otherParkedRows, roundBlocker } from "./roundJoin";
import { sweepExpiredToolApprovals } from "./toolApprovalSweeper";
import { submitElicitationAnswer } from "$lib/server/mcp/elicitation";
import { resumeParkedToolCall } from "$lib/server/mcp/resumeElicitation";
import { turnAwaitingInput } from "./turnState";
import type { ParkedCall } from "$lib/types/ParkedCall";
import type { Generation } from "$lib/types/Generation";

const MCP_UUID = "uuid-mcp";
const CODE_UUID = "uuid-code";
let conversationId: ObjectId;

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	// A sweep the answer endpoint kicked may still be running: let it finish before the data goes.
	await vi.waitFor(async () => {
		expect(await collections.parkedCalls.countDocuments({ status: "resuming" })).toBe(0);
	});
	seen.resumes.length = 0;
	await collections.parkedCalls.deleteMany({});
	await collections.generations.deleteMany({});
	await collections.turnStates.deleteMany({});
	await collections.mcpElicitations.deleteMany({ conversationId });
	await collections.conversations.deleteMany({ _id: conversationId });
});

const call = (uuid: string, name: string) => ({
	type: "tool",
	subtype: "call",
	uuid,
	call: { name, parameters: {} },
});
const mcpResult = (text: string) => ({
	type: "tool",
	subtype: "result",
	uuid: MCP_UUID,
	result: {
		status: "success",
		call: { name: "slow", parameters: {} },
		outputs: [{ text }],
		display: true,
	},
});

/** A turn parked mid-round: a slow MCP call and an execute_code call, emitted together. */
async function seedRound() {
	conversationId = new ObjectId();
	await collections.conversations.insertOne({
		_id: conversationId,
		model: "test/model",
		title: "round",
		rootMessageId: "sys",
		messages: [
			{ id: "sys", from: "system", content: "", children: ["user-1"] },
			{ id: "user-1", from: "user", content: "go", ancestors: ["sys"], children: ["asst-1"] },
			{
				id: "asst-1",
				from: "assistant",
				content: "",
				ancestors: ["sys", "user-1"],
				children: [],
				updates: [call(MCP_UUID, "slow"), call(CODE_UUID, "execute_code")],
			},
		],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
}

async function codeRow(over: Partial<ParkedCall> = {}) {
	const row: ParkedCall = {
		_id: new ObjectId(),
		parkedCallId: new ObjectId().toString(),
		conversationId,
		generationId: "gen-p",
		messageId: "asst-1",
		toolCallId: "call-code",
		toolUuid: CODE_UUID,
		kind: "code",
		status: "waiting",
		resumeAt: new Date(Date.now() - 1_000),
		reason: "code execution in the person's browser",
		code: "print(1)",
		// The fast call: the browser already answered.
		outcome: { stdout: "1\n", stderr: "", result: null, files: [] } as never,
		attempts: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	};
	await collections.parkedCalls.insertOne(row);
	return row;
}

/** The run that dispatched the round, still working on its slow call. */
async function producerRunning(heartbeatAgeMs = 0) {
	const now = new Date();
	await collections.generations.insertOne({
		_id: new ObjectId(),
		generationId: "gen-p",
		conversationId,
		messageId: "asst-1",
		status: "running",
		seq: 1,
		lastHeartbeatAt: new Date(now.getTime() - heartbeatAgeMs),
		startedAt: now,
		createdAt: now,
		updatedAt: now,
	} as Generation);
}

/** The producer ends having persisted its inline results (or a timeout error). */
async function producerFinishes(update: object) {
	await collections.conversations.updateOne({ _id: conversationId, "messages.id": "asst-1" }, {
		$push: { "messages.$.updates": update },
	} as never);
	await collections.generations.updateOne(
		{ generationId: "gen-p" },
		{ $set: { status: "completed", endedAt: new Date() } }
	);
}

/** Skip the deferral delay a test would otherwise sleep through. */
const makeDue = () =>
	collections.parkedCalls.updateMany({ status: "waiting" }, { $set: { resumeAt: new Date() } });

describe("a round's join (C155)", () => {
	it("does not resume on the fast call's answer while a slow sibling is still running, then resumes once with both results", async () => {
		await seedRound();
		await codeRow();
		await producerRunning();

		await sweepParkedCalls();

		// Code answered; the MCP call has not. No second producer, no resume.
		expect(seen.resumes).toHaveLength(0);
		const held = await collections.parkedCalls.findOne({ conversationId });
		expect(held?.status).toBe("waiting");
		// A deferral is not a failed attempt, and the answer is still on the row.
		expect(held?.attempts).toBe(0);
		expect(held?.outcome).toBeDefined();

		await producerFinishes(mcpResult("slow answer"));
		await makeDue();
		await sweepParkedCalls();

		expect(seen.resumes).toHaveLength(1);
		const uuids = seen.resumes[0].updates.map((u) => `${u.subtype}:${u.uuid}`);
		// Calls in the model's order; both results present when the model is asked again.
		expect(uuids.filter((u) => u.startsWith("call:"))).toEqual([
			`call:${MCP_UUID}`,
			`call:${CODE_UUID}`,
		]);
		expect(uuids).toContain(`result:${MCP_UUID}`);
		expect(uuids).toContain(`result:${CODE_UUID}`);
		expect((await collections.parkedCalls.findOne({ conversationId }))?.status).toBe("resumed");
	});

	it("resumes exactly once when both arrivals complete the round at the same moment", async () => {
		await seedRound();
		await codeRow();
		await producerRunning();
		await producerFinishes(mcpResult("done"));

		await Promise.all([sweepParkedCalls(), sweepParkedCalls(), sweepParkedCalls()]);

		expect(seen.resumes).toHaveLength(1);
	});

	it("completes with the slow call's timeout error when its producer reports one, and resumes once", async () => {
		await seedRound();
		await codeRow();
		await producerRunning();
		await sweepParkedCalls();
		expect(seen.resumes).toHaveLength(0);

		await producerFinishes({
			type: "tool",
			subtype: "error",
			uuid: MCP_UUID,
			message: "MCP tool call timed out",
		});
		await makeDue();
		await sweepParkedCalls();

		expect(seen.resumes).toHaveLength(1);
		expect(seen.resumes[0].updates.map((u) => `${u.subtype}:${u.uuid}`)).toContain(
			`error:${MCP_UUID}`
		);
	});

	it("is bounded: a producer that died (no heartbeat) does not hold the round open", async () => {
		await seedRound();
		await codeRow();
		// Heartbeat older than the reaper's threshold: the run is dead, not slow.
		await producerRunning(10 * 60_000);

		await sweepParkedCalls();

		expect(seen.resumes).toHaveLength(1);
	});

	it("does not resume a stopped round, even when the code answer is already in", async () => {
		await seedRound();
		await codeRow();
		await producerRunning();

		await endRoundOnStop(conversationId);
		await producerFinishes(mcpResult("late"));
		await makeDue();
		await sweepParkedCalls();

		expect(seen.resumes).toHaveLength(0);
		const row = await collections.parkedCalls.findOne({ conversationId });
		expect(row?.status).toBe("abandoned");
		expect(row?.abandonedReason).toBe("stopped by the user");
	});

	it("leaves a single-call round unchanged: resumes at once, nothing to wait for", async () => {
		await seedRound();
		await codeRow();
		// The producer ended when it parked, as it does for a one-call round.
		await producerRunning();
		await collections.generations.updateOne(
			{ generationId: "gen-p" },
			{ $set: { status: "completed" } }
		);

		await sweepParkedCalls();

		expect(seen.resumes).toHaveLength(1);
	});

	/** A tool approval of the round, shown and waiting for the user. */
	async function openApproval(elicitationId: string) {
		await collections.mcpElicitations.insertOne({
			_id: new ObjectId(),
			elicitationId,
			conversationId,
			status: "pending",
			request: { elicitationId, server: "web_fetch", mode: "form", message: "?", fields: [] },
			expiresAt: new Date(Date.now() + 60_000),
			pending: {
				kind: "tool-approval",
				tool: "web_fetch",
				args: { url: "https://unseen.test/" },
				queue: [],
				messageId: "asst-1",
				toolCallId: "call-mcp",
				toolUuid: MCP_UUID,
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
	}

	it("holds a code answer while an approval is unanswered, and until the approval's RESULT is applied (answered is not consumed)", async () => {
		await seedRound();
		await codeRow();
		await openApproval("elic-1");

		expect(await roundBlocker(conversationId, "asst-1")).toBe("approval");
		await sweepParkedCalls();
		expect(seen.resumes).toHaveLength(0);

		// The user answers through the real endpoint logic. The browser sends nothing else.
		const answered = await submitElicitationAnswer({
			elicitationId: "elic-1",
			conversationId,
			action: "decline",
		});
		expect(answered).toMatchObject({ ok: true, resume: false });

		// Answered, result not applied yet: a concurrent sweeper must not resume the turn
		// without the approval's result (the window of the first fix).
		const blockedWhile = await collections.mcpElicitations.findOne({ elicitationId: "elic-1" });
		expect(blockedWhile?.status).toBe("resolved");
		await Promise.all([sweepParkedCalls(), sweepParkedCalls(), sweepParkedCalls()]);
		await vi.waitFor(async () => {
			const row = await collections.mcpElicitations.findOne({ elicitationId: "elic-1" });
			expect(row?.consumedAt).toBeInstanceOf(Date);
		});
		// The server applied the refusal through the real resume path, then left the model to the
		// parked code call, which was still waiting for the approval: no model run yet.
		expect(seen.resumes).toHaveLength(0);
		const conv = await collections.conversations.findOne({ _id: conversationId });
		const updates = conv?.messages.find((m) => m.id === "asst-1")?.updates ?? [];
		expect(
			updates.some((u) => u.type === "tool" && u.subtype === "error" && u.uuid === MCP_UUID)
		).toBe(true);

		// The approval's apply woke the deferred code row: no waiting out its backoff.
		await sweepParkedCalls();

		expect(seen.resumes).toHaveLength(1);
		const uuids = seen.resumes[0].updates.map((u) => `${u.subtype}:${u.uuid}`);
		expect(uuids).toContain(`error:${MCP_UUID}`);
		expect(uuids).toContain(`result:${CODE_UUID}`);
	});

	it("applies an approved call on the server, with no browser request, and resumes the model once", async () => {
		await seedRound();
		await collections.conversations.updateOne({ _id: conversationId, "messages.id": "asst-1" }, {
			$push: { "messages.$.updates": mcpResult("unused") },
		} as never);
		await openApproval("elic-2");

		// Accepting with no connector to run it on: the real resume path records an error result.
		await submitElicitationAnswer({ elicitationId: "elic-2", conversationId, action: "accept" });
		await vi.waitFor(async () => {
			expect(seen.resumes).toHaveLength(1);
		});
		const row = await collections.mcpElicitations.findOne({ elicitationId: "elic-2" });
		expect(row?.consumedAt).toBeInstanceOf(Date);
	});

	it("ignores a browser's resume request for a tool approval, so the call cannot run twice", async () => {
		await seedRound();
		await openApproval("elic-3");
		await collections.mcpElicitations.updateOne(
			{ elicitationId: "elic-3" },
			{ $set: { status: "resolved", action: "accept" } }
		);

		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: "elic-3" });

		expect(outcome.resumed).toBe(false);
		expect(outcome.updates).toEqual([]);
	});

	it("counts another parked row of the turn", async () => {
		await seedRound();
		expect(await otherParkedRows(conversationId, "asst-1")).toBe(0);
		const row = await codeRow({ outcome: undefined, resumeAt: new Date(Date.now() + 60_000) });
		expect(await otherParkedRows(conversationId, "asst-1")).toBe(1);
		expect(await otherParkedRows(conversationId, "asst-1", row._id)).toBe(0);
	});

	it("abandons a row that was claimed but not started when the user stops", async () => {
		await seedRound();
		await codeRow({ status: "resuming", takenAt: new Date() });

		await endRoundOnStop(conversationId);

		expect((await collections.parkedCalls.findOne({ conversationId }))?.status).toBe("abandoned");
	});

	it("closes a turn left awaiting_input when the user stops mid-round, even with the producer still winding down", async () => {
		await seedRound();
		await codeRow();
		await producerRunning();
		// The park moved the turn to awaiting_input while the producer still runs its slow call.
		await turnAwaitingInput({ conversationId, messageId: "asst-1", producerId: "gen-p" });

		await endRoundOnStop(conversationId);

		const state = await collections.turnStates.findOne({ conversationId });
		expect(state?.status).toBe("failed");
		expect(state?.error).toBe("The turn was stopped.");
	});

	it("backs off a deferred resume: 3 s doubling to 60 s, counted on the row", async () => {
		expect([0, 1, 2, 10].map(deferDelayMs)).toEqual([3_000, 6_000, 12_000, 60_000]);
		await seedRound();
		await codeRow();
		await producerRunning();

		await sweepParkedCalls();
		await makeDue();
		await sweepParkedCalls();

		const row = await collections.parkedCalls.findOne({ conversationId });
		expect(row?.deferrals).toBe(2);
		expect(row?.attempts).toBe(0);
		expect((row?.resumeAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(4_000);
	});

	it("Stop closes an unanswered approval: its expiry later does nothing, a late click is refused, the turn stays stopped", async () => {
		await seedRound();
		await codeRow();
		await openApproval("elic-stop");
		await turnAwaitingInput({ conversationId, messageId: "asst-1", producerId: "gen-p" });

		await endRoundOnStop(conversationId);

		const closed = await collections.mcpElicitations.findOne({ elicitationId: "elic-stop" });
		expect(closed).toMatchObject({ status: "resolved", action: "cancel", stopped: true });
		expect(closed?.consumedAt).toBeInstanceOf(Date);
		// The prompt expires after the stop: the deny sweeper must not queue anything.
		await collections.mcpElicitations.updateOne(
			{ elicitationId: "elic-stop" },
			{ $set: { expiresAt: new Date(Date.now() - 1000) } }
		);
		await sweepExpiredToolApprovals();
		expect(await collections.parkedCalls.countDocuments({ parkedCallId: "elic-stop" })).toBe(0);
		// A click on the card that was still on screen is refused.
		expect(
			await submitElicitationAnswer({
				elicitationId: "elic-stop",
				conversationId,
				action: "accept",
			})
		).toMatchObject({ ok: false, status: 409 });
		await makeDue();
		await sweepParkedCalls();
		expect(seen.resumes).toHaveLength(0);
		expect((await collections.turnStates.findOne({ conversationId }))?.status).toBe("failed");
	});

	it("never resumes a turn that already ended, and never turns it back into a running one", async () => {
		await seedRound();
		await codeRow();
		await collections.turnStates.insertOne({
			_id: new ObjectId(),
			conversationId,
			messageId: "asst-1",
			producerId: "gen-p",
			status: "failed",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		await sweepParkedCalls();

		expect(seen.resumes).toHaveLength(0);
		expect((await collections.parkedCalls.findOne({ conversationId }))?.status).toBe("abandoned");
		expect((await collections.turnStates.findOne({ conversationId }))?.status).toBe("failed");
	});

	it("applies an approval answered before the upgrade (resolved, no row), once", async () => {
		await seedRound();
		await openApproval("elic-old");
		await collections.mcpElicitations.updateOne(
			{ elicitationId: "elic-old" },
			{ $set: { status: "resolved", action: "decline", resolvedAt: new Date() } }
		);

		expect(await backfillApprovalResumes()).toBeGreaterThanOrEqual(1);
		expect(await backfillApprovalResumes()).toBe(0);
		await sweepParkedCalls();

		await vi.waitFor(async () => {
			const row = await collections.mcpElicitations.findOne({ elicitationId: "elic-old" });
			expect(row?.consumedAt).toBeInstanceOf(Date);
		});
		expect(seen.resumes).toHaveLength(1);
		expect(await collections.parkedCalls.countDocuments({ parkedCallId: "elic-old" })).toBe(1);
	});
});
