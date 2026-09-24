import { describe, expect, it } from "vitest";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import type { Envelope, Message, Part, Transcript } from "$lib/types/machineProtocol";
import {
	eventToUpdates,
	foldEnvelopeEvents,
	frameKey,
	lastAssistantErrorOf,
	snapshotToUpdates,
	userMessageIdsOf,
} from "./machineTimeline";

function userMessage(id: string, clientMessageId?: string): Message {
	return { id, role: "user", createdAt: new Date().toISOString(), clientMessageId };
}

function assistantMessage(id: string, error?: string): Message {
	return { id, role: "assistant", createdAt: new Date().toISOString(), error };
}

function textPart(id: string, messageId: string, role: string, text: string): Part {
	return { id, messageId, role, type: "text", text };
}

describe("snapshotToUpdates", () => {
	it("maps a user text part to a `user` frame carrying its clientMessageId", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: userMessage("m1", "client-msg-1"),
					parts: [textPart("p1", "m1", "user", "hello there")],
				},
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		expect(updates[0]).toEqual({ type: "messageBoundary", role: "user", messageId: "m1" });
		expect(updates[1]).toEqual({ type: "user", text: "hello there", messageId: "client-msg-1" });
	});

	it("maps an assistant text part to a Stream update, and a tool part to call+result", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: assistantMessage("m2"),
					parts: [
						textPart("p2", "m2", "assistant", "on it"),
						{
							id: "p3",
							messageId: "m2",
							role: "assistant",
							type: "tool",
							callId: "call-1",
							tool: "bash",
							status: "completed",
							input: { command: "ls" },
							output: "file.txt",
						},
					],
				},
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		expect(updates).toContainEqual({ type: MessageUpdateType.Stream, token: "on it" });
		const call = updates.find((u) => u.type === MessageUpdateType.Tool && u.subtype === "call");
		const result = updates.find((u) => u.type === MessageUpdateType.Tool && u.subtype === "result");
		expect(call).toBeTruthy();
		expect(result).toBeTruthy();
	});

	it("maps status idle with a trailing assistant error to a failed turn state", () => {
		const transcript: Transcript = {
			messages: [{ message: assistantMessage("m3", "boom"), parts: [] }],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		const turnState = updates.find((u) => u.type === MessageUpdateType.TurnState);
		expect(turnState).toMatchObject({ state: "failed", reason: "boom" });
	});

	it("maps status idle with no error to a done turn state", () => {
		const transcript: Transcript = {
			messages: [{ message: assistantMessage("m4"), parts: [] }],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		const turnState = updates.find((u) => u.type === MessageUpdateType.TurnState);
		expect(turnState).toMatchObject({ state: "done" });
	});

	it("maps busy to a running turn state regardless of any prior error", () => {
		const transcript: Transcript = {
			messages: [{ message: assistantMessage("m5", "old failure"), parts: [] }],
			permissions: [],
			status: "busy",
			usage: null,
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		const turnState = updates.find((u) => u.type === MessageUpdateType.TurnState);
		expect(turnState).toMatchObject({ state: "running" });
	});

	it("surfaces pending permissions and todos", () => {
		const transcript: Transcript = {
			messages: [],
			permissions: [
				{
					id: "perm-1",
					sessionId: "s1",
					tool: "bash",
					title: "run rm -rf build/",
					patterns: [],
					metadata: { command: "rm -rf build/" },
					always: [],
				},
			],
			status: "busy",
			usage: null,
			todos: [{ id: "t1", content: "write tests", status: "in_progress" }],
		};
		const updates = snapshotToUpdates(transcript);
		expect(updates).toContainEqual(
			expect.objectContaining({ type: MessageUpdateType.Elicitation, subtype: "request" })
		);
		expect(updates).toContainEqual(expect.objectContaining({ type: MessageUpdateType.Plan }));
	});
});

describe("messageBoundary: the machine's own message id, for later actions to anchor on", () => {
	it("emits one boundary per message, immediately before that message's own frames", () => {
		const transcript: Transcript = {
			messages: [
				{ message: userMessage("m1"), parts: [textPart("p1", "m1", "user", "first")] },
				{ message: assistantMessage("m2"), parts: [textPart("p2", "m2", "assistant", "second")] },
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		expect(updates.slice(0, 4)).toEqual([
			{ type: "messageBoundary", role: "user", messageId: "m1" },
			{ type: "user", text: "first" },
			{ type: "messageBoundary", role: "assistant", messageId: "m2" },
			{ type: MessageUpdateType.Stream, token: "second" },
		]);
	});
});

describe("lastAssistantErrorOf / userMessageIdsOf", () => {
	it("returns the trailing assistant message's error only", () => {
		const transcript: Transcript = {
			messages: [
				{ message: assistantMessage("a1", "first failure"), parts: [] },
				{ message: userMessage("u1"), parts: [] },
				{ message: assistantMessage("a2"), parts: [] },
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		expect(lastAssistantErrorOf(transcript)).toBeUndefined();
	});

	it("collects every user message's clientMessageId by message id", () => {
		const transcript: Transcript = {
			messages: [
				{ message: userMessage("u1", "cmid-1"), parts: [] },
				{ message: assistantMessage("a1"), parts: [] },
				{ message: userMessage("u2", "cmid-2"), parts: [] },
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const ids = userMessageIdsOf(transcript);
		expect(ids.get("u1")).toBe("cmid-1");
		expect(ids.get("u2")).toBe("cmid-2");
	});
});

describe("the seam: duplicate identical tokens must not be dropped", () => {
	it("frameKey never de-duplicates Stream tokens or user echoes by content (R4's fix)", () => {
		const a = { type: MessageUpdateType.Stream as const, token: " the" };
		const b = { type: MessageUpdateType.Stream as const, token: " the" };
		expect(frameKey(a)).toBeNull();
		expect(frameKey(b)).toBeNull();
		expect(frameKey({ type: "user" as const, text: "yes" })).toBeNull();
	});

	it("two identical delta events both come through as two Stream frames", () => {
		const envelopes: Envelope[] = [
			{
				sessionId: "s1",
				epoch: "e1",
				seq: 1,
				event: {
					kind: "delta",
					messageId: "m1",
					partId: "p1",
					role: "assistant",
					field: "text",
					delta: " the",
				},
			},
			{
				sessionId: "s1",
				epoch: "e1",
				seq: 2,
				event: {
					kind: "delta",
					messageId: "m1",
					partId: "p1",
					role: "assistant",
					field: "text",
					delta: " the",
				},
			},
		];
		const { updates } = foldEnvelopeEvents(envelopes);
		const streamTokens = updates.filter((u) => u.type === MessageUpdateType.Stream);
		expect(streamTokens).toHaveLength(2);
		expect(streamTokens).toEqual([
			{ type: MessageUpdateType.Stream, token: " the" },
			{ type: MessageUpdateType.Stream, token: " the" },
		]);
	});

	it("a repeated user message with the same text is not dropped either", () => {
		const envelopes: Envelope[] = [
			{
				sessionId: "s1",
				epoch: "e1",
				seq: 1,
				event: { kind: "part", part: textPart("p1", "m1", "user", "continue") },
			},
			{
				sessionId: "s1",
				epoch: "e1",
				seq: 2,
				event: { kind: "part", part: textPart("p2", "m2", "user", "continue") },
			},
		];
		const { updates } = foldEnvelopeEvents(envelopes);
		expect(updates.filter((u) => u.type === "user")).toHaveLength(2);
	});
});

describe("a permission raised during a reconnect gap must appear", () => {
	it("shows up in a replayed run of envelopes even with no other activity", () => {
		const envelopes: Envelope[] = [
			{
				sessionId: "s1",
				epoch: "e1",
				seq: 5,
				event: {
					kind: "permission.asked",
					request: {
						id: "perm-1",
						sessionId: "s1",
						tool: "bash",
						title: "run rm -rf build/",
						patterns: [],
						metadata: {},
						always: [],
					},
				},
			},
		];
		const { updates } = foldEnvelopeEvents(envelopes);
		expect(updates).toContainEqual(
			expect.objectContaining({ type: MessageUpdateType.Elicitation, subtype: "request" })
		);
	});

	it("threads lastAssistantError and userMessageIds across a replayed run (spec §8)", () => {
		const envelopes: Envelope[] = [
			{
				sessionId: "s1",
				epoch: "e1",
				seq: 1,
				event: { kind: "message", message: userMessage("u1", "cmid-9") },
			},
			{
				sessionId: "s1",
				epoch: "e1",
				seq: 2,
				event: { kind: "part", part: textPart("p1", "u1", "user", "are you there?") },
			},
			{
				sessionId: "s1",
				epoch: "e1",
				seq: 3,
				event: { kind: "message", message: assistantMessage("a1", "provider timed out") },
			},
			{
				sessionId: "s1",
				epoch: "e1",
				seq: 4,
				event: { kind: "status", status: "idle" },
			},
		];
		const { updates, lastAssistantError, userMessageIds } = foldEnvelopeEvents(envelopes);
		expect(updates).toContainEqual({ type: "user", text: "are you there?", messageId: "cmid-9" });
		const turnState = updates.find((u) => u.type === MessageUpdateType.TurnState);
		expect(turnState).toMatchObject({ state: "failed", reason: "provider timed out" });
		expect(lastAssistantError).toBe("provider timed out");
		expect(userMessageIds.get("u1")).toBe("cmid-9");
	});
});

describe("eventToUpdates: one live event at a time", () => {
	it("maps status busy/idle/error and a dedicated error event", () => {
		expect(eventToUpdates({ kind: "status", status: "busy" })).toEqual([
			{ type: MessageUpdateType.TurnState, state: "running", serverNow: expect.any(Number) },
		]);
		expect(eventToUpdates({ kind: "status", status: "idle" })).toEqual([
			{ type: MessageUpdateType.TurnState, state: "done", serverNow: expect.any(Number) },
		]);
		expect(eventToUpdates({ kind: "error", message: "provider unavailable" })).toEqual([
			{
				type: MessageUpdateType.TurnState,
				state: "failed",
				serverNow: expect.any(Number),
				reason: "provider unavailable",
			},
		]);
	});

	it("maps a message event to a pure boundary marker, and drops session (no panel shape)", () => {
		expect(eventToUpdates({ kind: "message", message: assistantMessage("a1") })).toEqual([
			{ type: "messageBoundary", role: "assistant", messageId: "a1" },
		]);
	});

	it("resolves a part event's clientMessageId through the caller's resolver", () => {
		const updates = eventToUpdates(
			{ kind: "part", part: textPart("p1", "m1", "user", "hi") },
			undefined,
			(messageId) => (messageId === "m1" ? "cmid-1" : undefined)
		);
		expect(updates).toEqual([{ type: "user", text: "hi", messageId: "cmid-1" }]);
	});
});

describe("usage and compaction: a side channel that re-converges (M3)", () => {
	it("maps a live usage event to Cerea's own field names, contextMax present", () => {
		const updates = eventToUpdates({
			kind: "usage",
			usage: {
				input: 300,
				output: 80,
				reasoning: 5,
				cacheRead: 20,
				cacheWrite: 0,
				cost: 0.01,
				contextUsed: 405,
				contextMax: 1000,
			},
		});
		expect(updates).toEqual([
			{
				type: "usage",
				usage: { used: 405, max: 1000, input: 300, output: 80, cacheRead: 20, reasoning: 5 },
			},
		]);
	});

	it("omits `max` rather than inventing one when contextMax is null", () => {
		const updates = eventToUpdates({
			kind: "usage",
			usage: {
				input: 10,
				output: 5,
				reasoning: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextUsed: 15,
				contextMax: null,
			},
		});
		expect(updates).toEqual([
			{ type: "usage", usage: { used: 15, input: 10, output: 5, cacheRead: 0, reasoning: 0 } },
		]);
		expect(updates[0]).not.toHaveProperty("usage.max");
	});

	it("maps a compaction part to a compaction frame carrying `auto`", () => {
		const part: Part = {
			id: "p1",
			messageId: "m1",
			role: "assistant",
			type: "compaction",
			auto: true,
		};
		expect(eventToUpdates({ kind: "part", part })).toEqual([{ type: "compaction", auto: true }]);
	});

	it("snapshotToUpdates emits the transcript's usage once, after the rest of history", () => {
		const transcript: Transcript = {
			messages: [
				{ message: assistantMessage("a1"), parts: [textPart("p1", "a1", "assistant", "done")] },
			],
			permissions: [],
			status: "idle",
			usage: {
				input: 1,
				output: 1,
				reasoning: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextUsed: 2,
				contextMax: 100,
			},
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		const usageIndex = updates.findIndex((u) => u.type === "usage");
		expect(usageIndex).toBe(updates.length - 1);
		expect(updates[usageIndex]).toEqual({
			type: "usage",
			usage: { used: 2, max: 100, input: 1, output: 1, cacheRead: 0, reasoning: 0 },
		});
	});

	it("snapshotToUpdates emits no usage frame when the transcript carries none", () => {
		const transcript: Transcript = {
			messages: [],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		expect(snapshotToUpdates(transcript).some((u) => u.type === "usage")).toBe(false);
	});

	it("frameKey never de-duplicates usage or compaction frames — last write wins", () => {
		expect(frameKey({ type: "usage", usage: { used: 1 } })).toBeNull();
		expect(frameKey({ type: "compaction", auto: true })).toBeNull();
	});
});
