import { describe, expect, it } from "vitest";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import type {
	Envelope,
	Message,
	NormalizedEvent,
	Part,
	PermissionRequest,
	Transcript,
} from "$lib/types/machineProtocol";
import {
	answersFromQuestionOutput,
	eventToUpdates,
	commandMarkersOf,
	foldEnvelopeEvents,
	frameKey,
	lastAssistantErrorOf,
	newThinkingState,
	parseBackgroundTaskXml,
	permissionRequestToUpdate,
	providerRefusalReason,
	trackedErrorReason,
	questionRequestedToUpdate,
	snapshotToUpdates,
	userMessageIdsOf,
	type ChildContext,
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

function todowritePart(messageId: string, id = `tw-${messageId}`): Part {
	return {
		id,
		messageId,
		role: "assistant",
		type: "tool",
		callId: `call-${id}`,
		tool: "todowrite",
		status: "completed",
		input: {},
		output: "",
	};
}

describe("snapshotToUpdates", () => {
	it("offers an unanswered question again, as the assistant's own card (not a server's)", () => {
		const transcript: Transcript = {
			messages: [],
			permissions: [],
			questions: [
				{
					id: "que_1",
					callId: "call_q",
					questions: [
						{ question: "Which approach?", header: "Approach", options: [{ label: "A" }] },
					],
				},
			],
			status: "busy",
			usage: null,
			todos: [],
		};
		const request = snapshotToUpdates(transcript).find(
			(u) => u.type === MessageUpdateType.Elicitation && u.subtype === "request"
		);
		expect(request).toMatchObject({
			request: { elicitationId: "que_1", source: "assistant", server: "agent" },
		});
	});

	it("reads a machine that omits `questions` as none pending", () => {
		const transcript = {
			messages: [],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		} as Transcript;
		expect(
			snapshotToUpdates(transcript).some((u) => u.type === MessageUpdateType.Elicitation)
		).toBe(false);
	});

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
		expect(updates).toContainEqual({
			type: MessageUpdateType.Stream,
			token: "on it",
			partId: expect.any(String),
		});
		const call = updates.find((u) => u.type === MessageUpdateType.Tool && u.subtype === "call");
		const result = updates.find((u) => u.type === MessageUpdateType.Tool && u.subtype === "result");
		expect(call).toBeTruthy();
		expect(result).toBeTruthy();
	});

	it("maps status idle with a trailing assistant error to a failed turn state, framed as a provider refusal", () => {
		const transcript: Transcript = {
			messages: [{ message: assistantMessage("m3", "boom"), parts: [] }],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		const turnState = updates.find((u) => u.type === MessageUpdateType.TurnState);
		expect(turnState).toMatchObject({
			state: "failed",
			reason: "The model's provider refused the request: boom",
		});
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
			messages: [{ message: assistantMessage("m1"), parts: [todowritePart("m1")] }],
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
			{ type: MessageUpdateType.Stream, token: "second", partId: "p2" },
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
				seq: 0,
				event: { kind: "part", part: textPart("p1", "m1", "assistant", "") },
			},
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
			{ type: MessageUpdateType.Stream, token: " the", partId: "p1" },
			{ type: MessageUpdateType.Stream, token: " the", partId: "p1" },
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
		expect(turnState).toMatchObject({
			state: "failed",
			reason: "The model's provider refused the request: provider timed out",
		});
		expect(lastAssistantError).toBe("The model's provider refused the request: provider timed out");
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

	it("frames a provider refusal with an HTTP status on the failed turn, hinting on auth/payment ones", () => {
		const refusal = "AuthenticationError: Insufficient Balance.";
		for (const [code, hint] of [
			["401", " Check the provider's credit or key, or switch model."],
			["402", " Check the provider's credit or key, or switch model."],
			["403", " Check the provider's credit or key, or switch model."],
			["429", ""],
			["500", ""],
		] as const) {
			expect(providerRefusalReason(refusal, code)).toBe(
				`The model's provider refused the request: ${refusal}${hint}`
			);
			expect(eventToUpdates({ kind: "error", message: refusal, code })).toEqual([
				{
					type: MessageUpdateType.TurnState,
					state: "failed",
					serverNow: expect.any(Number),
					reason: `The model's provider refused the request: ${refusal}${hint}`,
				},
			]);
		}
	});

	it("shows a non-provider failure's message as it is, and an older galopin's empty one as nothing", () => {
		// An ACP backend's JSON-RPC code is not an HTTP status.
		expect(eventToUpdates({ kind: "error", message: "agent refused", code: "-32000" })).toEqual([
			{
				type: MessageUpdateType.TurnState,
				state: "failed",
				serverNow: expect.any(Number),
				reason: "agent refused",
			},
		]);
		// A command that would not run arrives uncoded, self-describing.
		expect(eventToUpdates({ kind: "error", message: 'The command "x" failed: boom' })).toEqual([
			{
				type: MessageUpdateType.TurnState,
				state: "failed",
				serverNow: expect.any(Number),
				reason: 'The command "x" failed: boom',
			},
		]);
		// An older galopin forwards an empty message: today's look.
		expect(eventToUpdates({ kind: "error", message: "" })).toEqual([
			{
				type: MessageUpdateType.TurnState,
				state: "failed",
				serverNow: expect.any(Number),
			},
		]);
	});

	it("keeps the hint on the failed turn through the idle that follows the error event", () => {
		// The real order (pinned by the real-opencode IT): the error event, then
		// the idle. The caller tracks the framed reason the event left behind,
		// so the idle's own failed state says the same thing.
		const refusal = "AuthenticationError: Insufficient Balance.";
		const framed =
			"The model's provider refused the request: " +
			refusal +
			" Check the provider's credit or key, or switch model.";
		const fromEvent = trackedErrorReason({ message: refusal, code: "401" });
		expect(fromEvent).toBe(framed);
		const envelopes: Envelope[] = [
			{
				sessionId: "s1",
				epoch: "e1",
				seq: 1,
				event: { kind: "error", message: refusal, code: "401" },
			},
			{ sessionId: "s1", epoch: "e1", seq: 2, event: { kind: "status", status: "idle" } },
		];
		const { updates, lastAssistantError } = foldEnvelopeEvents(envelopes, fromEvent);
		const states = updates.filter((u) => u.type === MessageUpdateType.TurnState);
		expect(states).toHaveLength(2);
		expect(states[1]).toMatchObject({ state: "failed", reason: framed });
		expect(lastAssistantError).toBe(framed);
	});

	it("a reloaded session frames the stored error without the hint (the snapshot carries no status)", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: assistantMessage("a1", "AuthenticationError: Insufficient Balance."),
					parts: [],
				},
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		expect(updates.find((u) => u.type === MessageUpdateType.TurnState)).toMatchObject({
			state: "failed",
			reason:
				"The model's provider refused the request: AuthenticationError: Insufficient Balance.",
		});
		expect(lastAssistantErrorOf(transcript)).toBe(
			"The model's provider refused the request: AuthenticationError: Insufficient Balance."
		);
	});

	it("carries the sender of a session_send message on the boundary, live and in a snapshot", () => {
		const sentBy = { sessionId: "ses_a", title: "Docs agent", hop: 1 };
		const message = { ...userMessage("m9"), sentBy };
		expect(eventToUpdates({ kind: "message", message })).toEqual([
			{ type: "messageBoundary", role: "user", messageId: "m9", sentBy },
		]);
		const updates = snapshotToUpdates({
			messages: [{ message, parts: [textPart("p9", "m9", "user", "please review")] }],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		});
		expect(updates[0]).toEqual({ type: "messageBoundary", role: "user", messageId: "m9", sentBy });
		// An assistant message never carries one, whatever the wire says.
		expect(
			eventToUpdates({ kind: "message", message: { ...assistantMessage("a9"), sentBy } })
		).toEqual([{ type: "messageBoundary", role: "assistant", messageId: "a9" }]);
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

describe("the agent-initiated question tool: opencode's native question, folded through elicitation", () => {
	it("maps question.asked to a lifted elicitation request, one select field per question", () => {
		const updates = eventToUpdates({
			kind: "question.asked",
			request: {
				id: "q-1",
				questions: [
					{
						question: "Which package manager?",
						header: "Setup",
						options: [{ label: "npm" }, { label: "pnpm", description: "faster installs" }],
					},
				],
			},
		});
		expect(updates).toEqual([
			{
				type: MessageUpdateType.Elicitation,
				subtype: "request",
				request: {
					elicitationId: "q-1",
					server: "agent",
					mode: "form",
					source: "assistant",
					message: "Which package manager?",
					fields: [
						{
							kind: "select",
							name: "q0",
							title: "Setup",
							description: "Which package manager?",
							required: true,
							multiple: false,
							options: [
								{ value: "npm", label: "npm", description: undefined },
								{ value: "pnpm", label: "pnpm", description: "faster installs" },
							],
							allowOther: true,
						},
					],
				},
			},
		]);
	});

	it("carries `multiple` through and joins several questions' text for the summary message", () => {
		const updates = eventToUpdates({
			kind: "question.asked",
			request: {
				id: "q-2",
				questions: [
					{ question: "Pick one", options: [{ label: "a" }] },
					{ question: "Pick any", options: [{ label: "b" }, { label: "c" }], multiple: true },
				],
			},
		});
		const request = (updates[0] as { request: { message: string; fields: unknown[] } }).request;
		expect(request.message).toBe("Pick one\n\nPick any");
		expect(request.fields).toHaveLength(2);
		expect(request.fields[1]).toMatchObject({ name: "q1", multiple: true });
	});

	it("offers free text, as opencode tells the model, unless the question turns `custom` off", () => {
		const updates = eventToUpdates({
			kind: "question.asked",
			request: {
				id: "q-3",
				questions: [
					{ question: "Default", options: [{ label: "a" }, { label: "b" }] },
					{ question: "Closed", options: [{ label: "a" }, { label: "b" }], custom: false },
				],
			},
		});
		const request = (updates[0] as { request: { fields: unknown[] } }).request;
		expect(request.fields[0]).toMatchObject({ allowOther: true });
		expect(request.fields[1]).toMatchObject({ allowOther: false });
	});

	it("maps question.resolved (accept) to a resolved elicitation carrying the chosen labels", () => {
		const updates = eventToUpdates({
			kind: "question.resolved",
			requestId: "q-1",
			answers: [["npm"]],
		});
		expect(updates).toEqual([
			{
				type: MessageUpdateType.Elicitation,
				subtype: "resolved",
				elicitationId: "q-1",
				action: "accept",
				resolution: "user",
				content: { q0: ["npm"] },
			},
		]);
	});

	it("maps question.resolved (rejected) to a declined elicitation with no content", () => {
		const updates = eventToUpdates({
			kind: "question.resolved",
			requestId: "q-1",
			rejected: true,
		});
		expect(updates).toEqual([
			{
				type: MessageUpdateType.Elicitation,
				subtype: "resolved",
				elicitationId: "q-1",
				action: "decline",
				resolution: "user",
			},
		]);
		expect(updates[0]).not.toHaveProperty("content");
	});
});

describe("an answered question, as a reload finds it", () => {
	const approach = {
		question: "Which approach?",
		header: "Approach",
		options: [{ label: "A" }, { label: "B" }],
	};
	const stack = {
		question: "Which parts?",
		header: "Parts",
		multiple: true,
		options: [{ label: "API, v2" }, { label: "UI" }],
	};
	const output = (body: string) =>
		`User has answered your questions: ${body}. You can now continue with the user's answers in mind.`;

	it("splits opencode's own result text back into per-question answers", () => {
		expect(
			answersFromQuestionOutput(
				[approach, stack],
				output(`"Which approach?"="B", "Which parts?"="API, v2, UI, and docs"`)
			)
		).toEqual([["B"], ["API, v2", "UI", "and docs"]]);
		expect(answersFromQuestionOutput([approach], output(`"Which approach?"="Unanswered"`))).toEqual(
			[[]]
		);
		expect(
			answersFromQuestionOutput([approach], output(`"Which approach?"="Neither, do C"`))
		).toEqual([["Neither, do C"]]);
	});

	it("gives up rather than guess when the wording is not opencode's", () => {
		expect(answersFromQuestionOutput([approach], "done")).toBeNull();
		expect(answersFromQuestionOutput([approach], undefined)).toBeNull();
	});

	it("rebuilds the answered card from a completed question tool part", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: assistantMessage("m2"),
					parts: [
						{
							id: "p9",
							messageId: "m2",
							role: "assistant",
							type: "tool",
							callId: "call_q",
							tool: "question",
							status: "completed",
							input: { questions: [approach] },
							output: output(`"Which approach?"="A"`),
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
		expect(updates).toContainEqual(
			expect.objectContaining({
				type: MessageUpdateType.Elicitation,
				subtype: "request",
				request: expect.objectContaining({
					elicitationId: "question-call:call_q",
					source: "assistant",
				}),
			})
		);
		expect(updates).toContainEqual(
			expect.objectContaining({
				type: MessageUpdateType.Elicitation,
				subtype: "resolved",
				elicitationId: "question-call:call_q",
				action: "accept",
				content: { q0: ["A"] },
			})
		);
	});
});

describe("subagent labelling", () => {
	const child: ChildContext = { childId: "child-1", childTitle: "Researcher" };

	function childPermissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
		return {
			id: "perm-1",
			sessionId: "child-1",
			tool: "bash",
			title: "run tests",
			patterns: [],
			metadata: {},
			always: [],
			...overrides,
		};
	}

	it("prefixes a child's permission ask with the subagent title and carries the child session", () => {
		const update = permissionRequestToUpdate(childPermissionRequest(), child);
		expect(update.type).toBe(MessageUpdateType.Elicitation);
		if (update.type !== MessageUpdateType.Elicitation || update.subtype !== "request") {
			throw new Error("expected an elicitation request");
		}
		expect(update.request.message).toBe("Subagent Researcher: run tests");
		expect(update.request.childSessionId).toBe("child-1");
		expect(update.request.childTitle).toBe("Researcher");
	});

	it("falls back to a bare Subagent label while the title is unknown", () => {
		const update = permissionRequestToUpdate(childPermissionRequest(), { childId: "child-1" });
		if (update.type !== MessageUpdateType.Elicitation || update.subtype !== "request") {
			throw new Error("expected an elicitation request");
		}
		expect(update.request.message).toBe("Subagent: run tests");
	});

	it("leaves the parent's own asks unlabelled and untargeted", () => {
		const update = permissionRequestToUpdate(childPermissionRequest());
		if (update.type !== MessageUpdateType.Elicitation || update.subtype !== "request") {
			throw new Error("expected an elicitation request");
		}
		expect(update.request.message).toBe("run tests");
		expect(update.request.childSessionId).toBeUndefined();
	});

	it("prefixes a child's question the same way, keeping its fields", () => {
		const update = questionRequestedToUpdate(
			{
				requestId: "q-1",
				questions: [
					{
						question: "Which approach?",
						header: "Approach",
						options: [{ label: "A" }, { label: "B" }],
					},
				],
			},
			child
		);
		if (update.type !== MessageUpdateType.Elicitation || update.subtype !== "request") {
			throw new Error("expected an elicitation request");
		}
		expect(update.request.message).toBe("Subagent Researcher: Which approach?");
		expect(update.request.fields).toHaveLength(1);
		expect(update.request.childSessionId).toBe("child-1");
	});
});

describe("child envelopes in eventToUpdates", () => {
	const child: ChildContext = { childId: "child-1", childTitle: "Researcher" };

	it("folds a child's part/delta/status into childActivity, never the parent transcript", () => {
		const events: NormalizedEvent[] = [
			{
				kind: "part",
				part: { id: "p1", messageId: "m1", role: "assistant", type: "text", text: "child text" },
			},
			{
				kind: "delta",
				messageId: "m1",
				partId: "p1",
				role: "assistant",
				field: "text",
				delta: "more",
			},
			{ kind: "status", status: "busy" },
			{ kind: "status", status: "idle" },
		];
		for (const event of events) {
			const updates = eventToUpdates(event, undefined, undefined, child);
			expect(updates).toEqual([{ type: "childActivity", childId: "child-1" }]);
		}
	});

	it("folds a child's permission ask/resolve as labelled cards", () => {
		const asked = eventToUpdates(
			{
				kind: "permission.asked",
				request: {
					id: "perm-1",
					sessionId: "child-1",
					tool: "bash",
					title: "run tests",
					patterns: [],
					metadata: {},
					always: [],
				},
			},
			undefined,
			undefined,
			child
		);
		expect(asked).toHaveLength(1);
		expect(JSON.stringify(asked[0])).toContain("Subagent Researcher: run tests");

		const resolved = eventToUpdates(
			{ kind: "permission.replied", requestId: "perm-1", decision: "once", by: "user" },
			undefined,
			undefined,
			child
		);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].type).toBe(MessageUpdateType.Elicitation);
	});
});

describe("foldEnvelopeEvents with a session tree", () => {
	const childEnvelope = (sessionId: string, event: NormalizedEvent, seq: number): Envelope => ({
		sessionId,
		epoch: "e1",
		seq,
		rootSessionId: "parent-1",
		event,
	});
	const childOf = (sessionId: string): ChildContext | undefined =>
		sessionId === "parent-1" ? undefined : { childId: sessionId, childTitle: "Researcher" };

	it("keeps the child's tokens out of the parent stream and labels its asks", () => {
		const { updates } = foldEnvelopeEvents(
			[
				childEnvelope("child-1", { kind: "status", status: "busy" }, 1),
				childEnvelope(
					"child-1",
					{
						kind: "part",
						part: { id: "p1", messageId: "m1", role: "assistant", type: "text", text: "hi" },
					},
					2
				),
				childEnvelope(
					"child-1",
					{
						kind: "permission.asked",
						request: {
							id: "perm-1",
							sessionId: "child-1",
							tool: "bash",
							title: "run tests",
							patterns: [],
							metadata: {},
							always: [],
						},
					},
					3
				),
				childEnvelope("parent-1", { kind: "status", status: "busy" }, 1),
			],
			undefined,
			undefined,
			childOf
		);
		expect(updates[0]).toEqual({ type: "childActivity", childId: "child-1" });
		expect(updates[1]).toEqual({ type: "childActivity", childId: "child-1" });
		expect(JSON.stringify(updates[2])).toContain("Subagent Researcher: run tests");
		// The parent's own status still folds to a running turn state.
		expect(updates[3]).toMatchObject({ type: MessageUpdateType.TurnState, state: "running" });
	});

	it("never lets a child's message events pollute the parent's tracked state", () => {
		const { lastAssistantError, userMessageIds } = foldEnvelopeEvents(
			[
				childEnvelope(
					"child-1",
					{
						kind: "message",
						message: { id: "cm", role: "assistant", createdAt: "", error: "boom" },
					},
					1
				),
			],
			undefined,
			undefined,
			childOf
		);
		expect(lastAssistantError).toBeUndefined();
		expect(userMessageIds.size).toBe(0);
	});
});

/**
 * The command marker (PROTOCOL.md §7): the machine tags the user message a
 * `session.command` produced, the timeline carries it on the `user` frame,
 * and the panel renders "/name args" as the bubble with the expanded
 * template folded beneath. Pinned here because the marker's two paths — a
 * snapshot read and a live part event resolved against the tracked
 * markers — must agree, or a reload changes what the transcript shows.
 */
describe("the command marker", () => {
	function commandMessage(id: string, name: string, args: string): Message {
		return {
			id,
			role: "user",
			createdAt: new Date().toISOString(),
			command: { name, arguments: args },
		};
	}

	it("rides the snapshot's user frame, with the expanded text as its own text", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: commandMessage("m1", "deploy", "--env prod"),
					parts: [textPart("p1", "m1", "user", "Run the deploy pipeline for prod now.")],
				},
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		expect(updates[1]).toEqual({
			type: "user",
			text: "Run the deploy pipeline for prod now.",
			command: { name: "deploy", arguments: "--env prod" },
		});
	});

	it("rides a live part event resolved against the tracked markers", () => {
		const marker = { name: "deploy", arguments: "" };
		const { updates } = foldEnvelopeEvents(
			[
				{
					sessionId: "s1",
					epoch: "e1",
					seq: 1,
					rootSessionId: "s1",
					event: {
						kind: "message",
						message: {
							id: "m1",
							role: "user",
							createdAt: new Date().toISOString(),
							command: marker,
						},
					},
				},
				{
					sessionId: "s1",
					epoch: "e1",
					seq: 2,
					rootSessionId: "s1",
					event: { kind: "part", part: textPart("p1", "m1", "user", "expanded text") },
				},
			],
			undefined,
			new Map(),
			undefined,
			new Map([["m1", marker]])
		);
		const user = updates.find((update) => update.type === "user");
		expect(user).toEqual({
			type: "user",
			text: "expanded text",
			command: { name: "deploy", arguments: "" },
		});
	});

	it("commandMarkersOf seeds the lookup from a snapshot", () => {
		const transcript: Transcript = {
			messages: [
				{ message: commandMessage("m1", "hi", "gamma"), parts: [] },
				{ message: assistantMessage("m2"), parts: [] },
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const markers = commandMarkersOf(transcript);
		expect(markers.get("m1")).toEqual({ name: "hi", arguments: "gamma" });
		expect(markers.has("m2")).toBe(false);
	});

	it("a plain user message carries no command field at all", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: userMessage("m1", "client-1"),
					parts: [textPart("p1", "m1", "user", "just a message")],
				},
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		expect(updates[1]).toEqual({ type: "user", text: "just a message", messageId: "client-1" });
		expect(updates[1]).not.toHaveProperty("command");
	});
});

describe("tool-output images (PROTOCOL.md §7 attachments)", () => {
	const shaA = "a".repeat(64);
	const shaB = "b".repeat(64);
	const url = (sha: string) => `/api/v2/code/v1/agents/s1/attachments/${sha}?device=d1`;

	function toolPart(attachments: unknown): Part {
		return {
			id: "p1",
			messageId: "m1",
			role: "assistant",
			type: "tool",
			callId: "call-img",
			tool: "playwright_screenshot",
			status: "completed",
			input: {},
			output: "took a screenshot",
			attachments,
		} as Part;
	}

	function resultOutputs(updates: ReturnType<typeof snapshotToUpdates>) {
		const result = updates.find((u) => u.type === MessageUpdateType.Tool && u.subtype === "result");
		return result && "result" in result && result.result.status === "success"
			? result.result.outputs
			: undefined;
	}

	function transcriptWith(part: Part): Transcript {
		return {
			messages: [{ message: assistantMessage("m1"), parts: [part] }],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
	}

	it("maps attachments to url image blocks beside the call's text, and no bytes", () => {
		const outputs = resultOutputs(
			snapshotToUpdates(
				transcriptWith(
					toolPart([
						{ sha256: shaA, mime: "image/png", size: 100 },
						{ sha256: shaB, mime: "image/jpeg", size: 200, filename: "b.jpg" },
					])
				),
				url
			)
		);
		expect(outputs).toEqual([
			{ text: "took a screenshot" },
			{
				content: [
					{ type: "image", mimeType: "image/png", url: url(shaA), size: 100 },
					{ type: "image", mimeType: "image/jpeg", url: url(shaB), size: 200 },
				],
			},
		]);
		expect(JSON.stringify(outputs)).not.toContain("base64");
	});

	it("adds nothing when there are no attachments, or no way to build a url", () => {
		expect(resultOutputs(snapshotToUpdates(transcriptWith(toolPart(undefined)), url))).toEqual([
			{ text: "took a screenshot" },
		]);
		expect(
			resultOutputs(
				snapshotToUpdates(transcriptWith(toolPart([{ sha256: shaA, mime: "image/png", size: 1 }])))
			)
		).toEqual([{ text: "took a screenshot" }]);
	});

	it("drops what the machine may not put in a url: a bad sha, an svg, an oversized image", () => {
		const outputs = resultOutputs(
			snapshotToUpdates(
				transcriptWith(
					toolPart([
						{ sha256: "../../x", mime: "image/png", size: 1 },
						{ sha256: shaA, mime: "image/svg+xml", size: 1 },
						{ sha256: shaB, mime: "image/png", size: 9 * 1024 * 1024 },
					])
				),
				url
			)
		);
		expect(outputs).toEqual([
			{ text: "took a screenshot" },
			{
				text: "3 images not shown (too many, too large or not a supported type).",
				imagesNotShown: 3,
			},
		]);
	});

	it("says when the machine itself left images out", () => {
		const part = {
			...toolPart([{ sha256: shaA, mime: "image/png", size: 100 }]),
			attachmentsOmitted: 1,
		};
		const outputs = resultOutputs(snapshotToUpdates(transcriptWith(part as Part), url));
		expect(outputs?.[2]).toEqual({
			text: "1 image not shown (too many, too large or not a supported type).",
			imagesNotShown: 1,
		});
		// No url builder, no images, no note.
		expect(resultOutputs(snapshotToUpdates(transcriptWith(part as Part)))).toEqual([
			{ text: "took a screenshot" },
		]);
	});

	it("caps the images taken from one call", () => {
		const many = Array.from({ length: 20 }, (_, i) => ({
			sha256: i.toString(16).padStart(64, "0"),
			mime: "image/png",
			size: 10,
		}));
		const outputs = resultOutputs(snapshotToUpdates(transcriptWith(toolPart(many)), url));
		const content = (outputs?.[1] as { content: unknown[] }).content;
		expect(content).toHaveLength(8);
		expect(outputs?.[2]).toEqual({
			text: "12 images not shown (too many, too large or not a supported type).",
			imagesNotShown: 12,
		});
	});

	it("gives a live part event the same frames a snapshot does (one mapping)", () => {
		const part = toolPart([{ sha256: shaA, mime: "image/png", size: 100 }]);
		const live = foldEnvelopeEvents(
			[{ sessionId: "s1", epoch: "e", seq: 1, event: { kind: "part", part } }],
			undefined,
			undefined,
			undefined,
			undefined,
			url
		).updates;
		const snap = snapshotToUpdates(transcriptWith(part), url);
		expect(resultOutputs(live)).toEqual(resultOutputs(snap));
		expect(resultOutputs(live)).toHaveLength(2);
	});
});

describe("todos → the plan update", () => {
	const todoEvent = (
		todos: Extract<NormalizedEvent, { kind: "todo" }>["todos"]
	): NormalizedEvent => ({
		kind: "todo",
		todos,
	});
	const planOf = (updates: ReturnType<typeof eventToUpdates>) => {
		const plan = updates.find((u) => u.type === MessageUpdateType.Plan);
		if (!plan || plan.type !== MessageUpdateType.Plan) throw new Error("no plan update");
		return plan;
	};

	it("maps every todo status, a cancelled item to skipped (not still-to-do)", () => {
		const plan = planOf(
			eventToUpdates(
				todoEvent([
					{ id: "1", content: "a", status: "completed" },
					{ id: "2", content: "b", status: "in_progress" },
					{ id: "3", content: "c", status: "pending" },
					{ id: "4", content: "d", status: "cancelled" },
				]),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				"ses_a"
			)
		);
		expect(plan.steps.map((s) => s.status)).toEqual([
			"completed",
			"in_progress",
			"pending",
			"skipped",
		]);
	});

	it("carries the todo's priority onto its step, and only when it has one", () => {
		const plan = planOf(
			eventToUpdates(
				todoEvent([
					{ id: "1", content: "a", status: "pending", priority: "high" },
					{ id: "2", content: "b", status: "pending" },
				])
			)
		);
		expect(plan.steps).toEqual([
			{ step: "a", status: "pending", priority: "high" },
			{ step: "b", status: "pending" },
		]);
	});

	it("maps a snapshot's cancelled todo the same way the live event does", () => {
		const transcript: Transcript = {
			messages: [{ message: assistantMessage("m1"), parts: [todowritePart("m1")] }],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [{ id: "1", content: "dropped", status: "cancelled" }],
		};
		const plan = planOf(snapshotToUpdates(transcript, undefined, "ses_a"));
		expect(plan.steps).toEqual([{ step: "dropped", status: "skipped" }]);
	});

	it("keys the plan and its revision per session, never across sessions", () => {
		let n = 0;
		const update = (sessionId: string) =>
			planOf(
				eventToUpdates(
					// a changed list each call: an identical one makes no update
					todoEvent([{ id: "1", content: `x${n++}`, status: "pending" as const }]),
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					sessionId
				)
			);
		const a1 = update("ses_key_a");
		const a2 = update("ses_key_a");
		const b1 = update("ses_key_b");
		expect(a1.uuid).toBe("agent-plan-ses_key_a");
		expect(b1.uuid).toBe("agent-plan-ses_key_b");
		expect(a2.version).toBe(a1.version + 1);
		// Another session's revision is untouched by A's traffic.
		expect(b1.version).toBe(1);
	});

	it("skips a live todo event identical to the last one sent for the session", () => {
		type Todos = Extract<NormalizedEvent, { kind: "todo" }>["todos"];
		const todos: Todos = [
			{ id: "1", content: "a", status: "pending", priority: "high" },
			{ id: "2", content: "b", status: "pending" },
		];
		const stream = newThinkingState();
		const send = (list: Todos, sessionId = "ses_dup", state = stream) =>
			eventToUpdates(
				todoEvent(list),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				sessionId,
				state
			).filter((u) => u.type === MessageUpdateType.Plan);
		expect(send(todos)).toHaveLength(1);
		expect(send(todos.map((t) => ({ ...t })))).toHaveLength(0);
		// a real change goes through, with the next version
		const changed: Todos = [{ ...todos[0], status: "completed" }, todos[1]];
		const [next] = send(changed);
		expect(next).toMatchObject({ version: 2 });
		// another session is its own stream
		expect(send(todos, "ses_dup_other")).toHaveLength(1);
	});

	it("gives every viewer's stream its own plan changes", () => {
		// Two browsers on one session: each connection maps the same event,
		// and the first one's memory must not swallow it for the second.
		type Todos = Extract<NormalizedEvent, { kind: "todo" }>["todos"];
		const todos: Todos = [{ id: "1", content: "a", status: "pending" }];
		const desktop = newThinkingState();
		const phone = newThinkingState();
		const send = (state: ReturnType<typeof newThinkingState>) =>
			eventToUpdates(
				todoEvent(todos),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				"ses_two_viewers",
				state
			).filter((u) => u.type === MessageUpdateType.Plan);
		expect(send(desktop)).toHaveLength(1);
		expect(send(phone)).toHaveLength(1);
		expect(send(phone)).toHaveLength(0);
	});

	describe("in a snapshot", () => {
		const todos = [{ id: "1", content: "step", status: "in_progress" as const }];
		const snap = (
			messages: Transcript["messages"],
			sessionId: string,
			list = todos,
			state = newThinkingState()
		) =>
			snapshotToUpdates(
				{ messages, permissions: [], status: "idle", usage: null, todos: list },
				undefined,
				sessionId,
				state
			);
		const order = (updates: ReturnType<typeof snap>) =>
			updates
				.filter((u) => u.type === "messageBoundary" || u.type === MessageUpdateType.Plan)
				.map((u) => (u.type === "messageBoundary" ? u.messageId : "PLAN"));

		it("puts the plan right after the message of the last todowrite, not at the end", () => {
			const updates = snap(
				[
					{ message: assistantMessage("m1"), parts: [todowritePart("m1", "a")] },
					{ message: assistantMessage("m2"), parts: [todowritePart("m2", "b")] },
					{ message: assistantMessage("m3"), parts: [textPart("t3", "m3", "assistant", "done")] },
				],
				"ses_snap_a"
			);
			expect(order(updates)).toEqual(["m1", "m2", "PLAN", "m3"]);
		});

		it("emits no plan when the transcript has todos but no todowrite part", () => {
			const updates = snap(
				[{ message: assistantMessage("m1"), parts: [textPart("t1", "m1", "assistant", "hi")] }],
				"ses_snap_b"
			);
			expect(order(updates)).toEqual(["m1"]);
		});

		it("does not repeat the snapshot's plan when the same list arrives live", () => {
			const stream = newThinkingState();
			snap(
				[{ message: assistantMessage("m1"), parts: [todowritePart("m1")] }],
				"ses_snap_c",
				todos,
				stream
			);
			const live = eventToUpdates(
				{ kind: "todo", todos },
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				"ses_snap_c",
				stream
			);
			expect(live.filter((u) => u.type === MessageUpdateType.Plan)).toHaveLength(0);
		});
	});
});

/**
 * The Needs-you inbox renders the SAME cards from the SAME payloads: the
 * shared mapping in `$lib/utils/codeInboxCards` must equal what these
 * update wrappers carry, or the stream and the inbox have drifted apart.
 */
describe("inbox card parity (codeInboxCards)", () => {
	it("builds the same permission payload the stream card carries", async () => {
		const { permissionToElicitation } = await import("$lib/utils/codeInboxCards");
		const request: PermissionRequest = {
			id: "perm-1",
			sessionId: "s1",
			tool: "bash",
			title: "run tests",
			patterns: [],
			metadata: { argv: ["ls"] },
			always: [],
		};
		const update = permissionRequestToUpdate(request);
		if (update.type !== MessageUpdateType.Elicitation || update.subtype !== "request") {
			throw new Error("expected an elicitation request");
		}
		expect(permissionToElicitation(request)).toEqual(update.request);
	});

	it("builds the same question payload the stream card carries", async () => {
		const { questionToElicitation } = await import("$lib/utils/codeInboxCards");
		const questions = [
			{ question: "Which approach?", header: "Approach", options: [{ label: "A" }] },
		];
		const update = questionRequestedToUpdate({ requestId: "q-1", questions });
		if (update.type !== MessageUpdateType.Elicitation || update.subtype !== "request") {
			throw new Error("expected an elicitation request");
		}
		expect(questionToElicitation("q-1", questions)).toEqual(update.request);
	});
});

describe("background task markers", () => {
	const RUNNING_XML = `<task id="ses_child1" state="running">
<summary>Background task started: Survey the repo</summary>
<task_result>
The task is working in the background. You will be notified automatically when it finishes.
</task_result>
</task>`;
	const COMPLETED_XML = `<task id="ses_child1" state="completed">
<summary>Background task completed: Survey the repo</summary>
<task_result>
The repo holds a SvelteKit app.
</task_result>
</task>`;

	function taskToolPart(overrides: Partial<Part> = {}): Part {
		return {
			id: "p-task",
			messageId: "m-task",
			role: "assistant",
			type: "tool",
			callId: "call_task1",
			tool: "task",
			status: "completed",
			input: { description: "Survey the repo", background: true },
			output: RUNNING_XML,
			...overrides,
		} as Part;
	}

	function syntheticPart(text: string): Part {
		return {
			id: "p-syn",
			messageId: "m-syn",
			role: "assistant",
			type: "text",
			text,
			synthetic: true,
		};
	}

	function transcriptWith(parts: Part[]): Transcript {
		return {
			messages: [{ message: assistantMessage("m1"), parts }],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
	}

	it("parses opencode's running/completed envelopes and rejects prose", () => {
		expect(parseBackgroundTaskXml(RUNNING_XML)).toMatchObject({
			id: "ses_child1",
			state: "running",
			summary: "Background task started: Survey the repo",
		});
		expect(parseBackgroundTaskXml(COMPLETED_XML)).toMatchObject({
			id: "ses_child1",
			state: "completed",
			text: "The repo holds a SvelteKit app.",
		});
		expect(parseBackgroundTaskXml("just model prose")).toBeNull();
		expect(
			parseBackgroundTaskXml('<task id="x" state="bogus"><task_result>t</task_result></task>')
		).toBeNull();
	});

	it("marks a background:true task call as running, anchored on its call", () => {
		const updates = snapshotToUpdates(transcriptWith([taskToolPart()]));
		expect(updates).toContainEqual({
			type: MessageUpdateType.BackgroundTask,
			taskId: "ses_child1",
			callId: "call_task1",
			state: "running",
			summary: "Background task started: Survey the repo",
			text: "The task is working in the background. You will be notified automatically when it finishes.",
		});
	});

	it("leaves a foreground task's completed output on its tool card alone", () => {
		const updates = snapshotToUpdates(
			transcriptWith([
				taskToolPart({
					input: { description: "Survey the repo" },
					output: COMPLETED_XML,
				}),
			])
		);
		expect(updates.some((u) => u.type === MessageUpdateType.BackgroundTask)).toBe(false);
		expect(updates.some((u) => u.type === MessageUpdateType.Tool && u.subtype === "result")).toBe(
			true
		);
	});

	it("names a task_id resume a follow-up", () => {
		const updates = snapshotToUpdates(
			transcriptWith([
				taskToolPart({ input: { description: "More", task_id: "ses_child1", background: true } }),
			])
		);
		expect(updates).toContainEqual(
			expect.objectContaining({
				type: MessageUpdateType.BackgroundTask,
				taskId: "ses_child1",
				state: "running",
				followUp: true,
			})
		);
	});

	it("folds a synthetic completion into an automatic marker, and drops other synthetics", () => {
		const updates = snapshotToUpdates(
			transcriptWith([syntheticPart(COMPLETED_XML), syntheticPart("a compaction reminder")])
		);
		const markers = updates.filter((u) => u.type === MessageUpdateType.BackgroundTask);
		expect(markers).toHaveLength(1);
		expect(markers[0]).toMatchObject({
			taskId: "ses_child1",
			state: "completed",
			automatic: true,
			text: "The repo holds a SvelteKit app.",
		});
		// No stream tokens leak from either synthetic part.
		expect(updates.some((u) => u.type === MessageUpdateType.Stream)).toBe(false);
	});

	it("keys a background marker by child, call and state", () => {
		const marker = {
			type: MessageUpdateType.BackgroundTask,
			taskId: "ses_child1",
			callId: "call_task1",
			state: "running",
		} as const;
		expect(frameKey(marker)).toBe("b:ses_child1:call_task1:running");
		expect(frameKey({ ...marker, state: "completed", callId: undefined })).toBe(
			"b:ses_child1::completed"
		);
	});
});

describe("tool-image size passthrough", () => {
	it("carries each attachment's size onto its image block, for the strip's load gate", () => {
		const sha = "a".repeat(64);
		const updates = eventToUpdates(
			{
				kind: "part",
				part: {
					id: "p1",
					messageId: "m1",
					role: "assistant",
					type: "tool",
					callId: "c1",
					tool: "playwright_screenshot",
					status: "completed",
					input: {},
					output: "ok",
					attachments: [{ sha256: sha, mime: "image/png", size: 5_000_000 }],
				},
			},
			undefined,
			undefined,
			undefined,
			undefined,
			(s) => `/img/${s}`
		);
		const result = updates.find(
			(u) => u.type === MessageUpdateType.Tool && u.subtype === "result"
		) as { result: { outputs: Record<string, unknown>[] } } | undefined;
		expect(result?.result.outputs[1]).toEqual({
			content: [{ type: "image", mimeType: "image/png", url: `/img/${sha}`, size: 5_000_000 }],
		});
	});
});

describe("agent thinking: the chat's own <think> wrapping", () => {
	const reasoningPart = (id: string, messageId: string, text: string): Part => ({
		id,
		messageId,
		role: "assistant",
		type: "reasoning",
		text,
	});
	const toolPart = (
		id: string,
		messageId: string,
		callId: string,
		status: "running" | "completed" = "running"
	): Part => ({
		id,
		messageId,
		role: "assistant",
		type: "tool",
		callId,
		tool: "bash",
		status,
		input: { command: "ls" },
		...(status === "completed" ? { output: "ok" } : {}),
	});
	const delta = (partId: string, text: string, messageId = "m1"): NormalizedEvent => ({
		kind: "delta",
		messageId,
		partId,
		role: "assistant",
		field: "text",
		delta: text,
	});
	const part = (p: Part): NormalizedEvent => ({ kind: "part", part: p });
	const wrap = (events: NormalizedEvent[]): Envelope[] =>
		events.map((event, i) => ({ sessionId: "s1", epoch: "e1", seq: i + 1, event }));
	/** Stream tokens only, joined: what ChatMessage's content ends up as. */
	const streamText = (updates: { type: unknown; token?: string }[]) =>
		updates
			.filter((u) => u.type === MessageUpdateType.Stream)
			.map((u) => u.token)
			.join("");
	const think = (text: string) => `<think>${text}</think>`;

	it("live: reasoning part and deltas, then a text part and deltas, are thinking then answer", () => {
		const { updates } = foldEnvelopeEvents(
			wrap([
				part(reasoningPart("r1", "m1", "The user wants")),
				delta("r1", " me to refuse"),
				part(textPart("t1", "m1", "assistant", "")),
				delta("t1", "I can't"),
				delta("t1", " — sorry."),
				{ kind: "status", status: "idle" },
			])
		);
		expect(streamText(updates)).toBe(`${think("The user wants me to refuse")}I can't — sorry.`);
		// The block is closed before the first answer token, not after it.
		const tokens = updates.filter((u) => u.type === MessageUpdateType.Stream);
		expect(tokens.map((u) => u.token)).toEqual([
			"<think>The user wants",
			" me to refuse",
			"</think>",
			"I can't",
			" — sorry.",
		]);
	});

	it("live: a text part that carries its first text closes the thinking too", () => {
		const { updates } = foldEnvelopeEvents(
			wrap([
				part(reasoningPart("r1", "m1", "hmm")),
				part(textPart("t1", "m1", "assistant", "Answer")),
			])
		);
		expect(streamText(updates)).toBe(`${think("hmm")}Answer`);
	});

	it("live: a delta that arrives before its part is held until the part says what it is", () => {
		const thinking = newThinkingState();
		const first = eventToUpdates(
			delta("r1", "early thought"),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"s1",
			thinking
		);
		expect(first).toEqual([]);
		const second = eventToUpdates(
			part(reasoningPart("r1", "m1", "")),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"s1",
			thinking
		);
		expect(streamText(second)).toBe("<think>early thought");
		const after = eventToUpdates(
			delta("r1", " and more"),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"s1",
			thinking
		);
		expect(streamText(after)).toBe(" and more");
	});

	it("live: a delta whose part never arrives is released as answer text when the turn ends", () => {
		const { updates } = foldEnvelopeEvents(
			wrap([delta("t9", "orphan"), { kind: "status", status: "idle" }])
		);
		expect(streamText(updates)).toBe("orphan");
		// ...and before the turn-state frame that ended it.
		expect(updates.at(-1)?.type).toBe(MessageUpdateType.TurnState);
	});

	it("live: reasoning, tool call, reasoning, text keep their order", () => {
		const { updates } = foldEnvelopeEvents(
			wrap([
				part(reasoningPart("r1", "m1", "first")),
				part(toolPart("tool1", "m1", "call_1")),
				part(reasoningPart("r2", "m2", "second")),
				delta("r2", " thought", "m2"),
				part(textPart("t1", "m2", "assistant", "done")),
			])
		);
		const shape = updates.map((u) =>
			u.type === MessageUpdateType.Stream
				? u.token
				: u.type === MessageUpdateType.Tool
					? "tool"
					: null
		);
		expect(shape.filter((x) => x !== null)).toEqual([
			"<think>first",
			"</think>",
			"tool",
			"<think>second",
			" thought",
			"</think>",
			"done",
		]);
	});

	it("live: a usage frame in the middle of thinking does not split the block", () => {
		const { updates } = foldEnvelopeEvents(
			wrap([
				part(reasoningPart("r1", "m1", "a")),
				{
					kind: "usage",
					usage: {
						input: 1,
						output: 1,
						reasoning: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						contextUsed: 1,
						contextMax: null,
					},
				},
				delta("r1", "b"),
			])
		);
		expect(streamText(updates)).toBe("<think>ab");
	});

	it("live: a ThinkingState seeded from a snapshot routes the deltas of parts announced before it", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: assistantMessage("m1"),
					parts: [reasoningPart("r1", "m1", "so far")],
				},
			],
			permissions: [],
			questions: [],
			status: "busy",
			usage: null,
			todos: [],
		};
		const thinking = newThinkingState();
		const initial = snapshotToUpdates(transcript, undefined, "s1", thinking);
		// Still being written: left open, so the live deltas continue the block.
		expect(streamText(initial)).toBe("<think>so far");
		const { updates } = foldEnvelopeEvents(
			wrap([delta("r1", " and on"), part(textPart("t1", "m1", "assistant", "Answer"))]),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			thinking
		);
		expect(streamText(updates)).toBe(` and on</think>Answer`);
	});

	it("reload: reasoning and text parts become a closed block then the answer, in order", () => {
		const transcript: Transcript = {
			messages: [
				{ message: userMessage("u1"), parts: [textPart("up", "u1", "user", "hi")] },
				{
					message: assistantMessage("m1"),
					parts: [
						reasoningPart("r1", "m1", "The user wants me to…"),
						textPart("t1", "m1", "assistant", "I can't — "),
					],
				},
			],
			permissions: [],
			questions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const updates = snapshotToUpdates(transcript);
		expect(streamText(updates)).toBe(`${think("The user wants me to…")}I can't — `);
	});

	it("reload: reasoning, tool, reasoning, text keep their order", () => {
		const transcript: Transcript = {
			messages: [
				{
					message: assistantMessage("m1"),
					parts: [
						reasoningPart("r1", "m1", "one"),
						toolPart("tool1", "m1", "call_1", "completed"),
						reasoningPart("r2", "m1", "two"),
						textPart("t1", "m1", "assistant", "end"),
					],
				},
			],
			permissions: [],
			questions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		const shape = snapshotToUpdates(transcript)
			.map((u) =>
				u.type === MessageUpdateType.Stream
					? u.token
					: u.type === MessageUpdateType.Tool
						? "tool"
						: null
			)
			.filter((x) => x !== null);
		expect(shape).toEqual([think("one"), "tool", "tool", think("two"), "end"]);
	});

	it("reload: an empty reasoning part adds nothing", () => {
		const transcript: Transcript = {
			messages: [{ message: assistantMessage("m1"), parts: [reasoningPart("r1", "m1", "")] }],
			permissions: [],
			questions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		expect(streamText(snapshotToUpdates(transcript))).toBe("");
	});

	it("a subagent's own events stay out of the parent transcript, thinking included", () => {
		const child: ChildContext = { childId: "c1", childTitle: null };
		const thinking = newThinkingState();
		const out = eventToUpdates(
			part(reasoningPart("r1", "m1", "child thought")),
			undefined,
			undefined,
			child,
			undefined,
			undefined,
			"s1",
			thinking
		);
		expect(out).toEqual([{ type: "childActivity", childId: "c1" }]);
	});
});
