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
import { parkedRowOpen, roundBlocker } from "./roundJoin";
import type { ParkedCall } from "$lib/types/ParkedCall";
import type { Generation } from "$lib/types/Generation";

const MCP_UUID = "uuid-mcp";
const CODE_UUID = "uuid-code";
let conversationId: ObjectId;

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
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
		const held = await collections.parkedCalls.findOne({});
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
		expect((await collections.parkedCalls.findOne({}))?.status).toBe("resumed");
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
		const row = await collections.parkedCalls.findOne({});
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

	it("holds a code answer while an approval of the same round is unanswered, then resumes once it is answered", async () => {
		await seedRound();
		await codeRow();
		await collections.mcpElicitations.insertOne({
			_id: new ObjectId(),
			elicitationId: "elic-1",
			conversationId,
			status: "pending",
			request: {} as never,
			expiresAt: new Date(Date.now() + 60_000),
			pending: {
				kind: "tool-approval",
				messageId: "asst-1",
				toolCallId: "call-mcp",
				toolUuid: MCP_UUID,
			} as never,
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		expect(await roundBlocker(conversationId, "asst-1")).toBe("approval");
		await sweepParkedCalls();
		expect(seen.resumes).toHaveLength(0);

		// The user answers; the approved call's result lands in the turn.
		await collections.mcpElicitations.updateOne(
			{ elicitationId: "elic-1" },
			{ $set: { status: "resolved" } }
		);
		await collections.conversations.updateOne({ _id: conversationId, "messages.id": "asst-1" }, {
			$push: { "messages.$.updates": mcpResult("approved result") },
		} as never);
		await makeDue();
		await sweepParkedCalls();

		expect(seen.resumes).toHaveLength(1);
		expect(seen.resumes[0].updates.map((u) => `${u.subtype}:${u.uuid}`)).toContain(
			`result:${MCP_UUID}`
		);
	});

	it("tells an approval answer that a parked call of its round is left to resume the turn", async () => {
		await seedRound();
		expect(await parkedRowOpen(conversationId, "asst-1")).toBe(false);
		await codeRow({ outcome: undefined, resumeAt: new Date(Date.now() + 60_000) });
		expect(await parkedRowOpen(conversationId, "asst-1")).toBe(true);
	});
});
