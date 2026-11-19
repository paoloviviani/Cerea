import { describe, expect, test } from "vitest";

import type { Message } from "$lib/types/Message";
import { MessageUpdateStatus, MessageUpdateType } from "$lib/types/MessageUpdate";
import {
	failedTurnReasonOf,
	isAssistantGenerationTerminal,
	isConversationGenerationActive,
	isTurnSubscribable,
	createReattachGuard,
	reconcileWithTurnState,
	streamErrorOf,
	lastFailedTurnId,
	turnStateOf,
} from "./generationState";

function assistantMessage(overrides: Partial<Message> = {}): Message {
	return {
		from: "assistant",
		id: "assistant-1" as Message["id"],
		content: "",
		children: [],
		...overrides,
	};
}

describe("generationState", () => {
	test("returns active when assistant has no terminal update", () => {
		const messages = [
			assistantMessage({
				updates: [{ type: MessageUpdateType.Stream, token: "Hello" }],
			}),
		];

		expect(isConversationGenerationActive(messages)).toBe(true);
	});

	test("treats final answer update as terminal", () => {
		const message = assistantMessage({
			updates: [{ type: MessageUpdateType.FinalAnswer, text: "Done", interrupted: false }],
		});

		expect(isAssistantGenerationTerminal(message)).toBe(true);
		expect(isConversationGenerationActive([message])).toBe(false);
	});

	test("treats error status update as terminal", () => {
		const message = assistantMessage({
			updates: [
				{
					type: MessageUpdateType.Status,
					status: MessageUpdateStatus.Error,
					message: "Something went wrong",
				},
			],
		});

		expect(isAssistantGenerationTerminal(message)).toBe(true);
		expect(isConversationGenerationActive([message])).toBe(false);
	});

	test("treats finished status update as terminal", () => {
		const message = assistantMessage({
			updates: [
				{
					type: MessageUpdateType.Status,
					status: MessageUpdateStatus.Finished,
				},
			],
		});

		expect(isAssistantGenerationTerminal(message)).toBe(true);
		expect(isConversationGenerationActive([message])).toBe(false);
	});

	test("treats interrupted assistant message as terminal", () => {
		const message = assistantMessage({
			interrupted: true,
			updates: [{ type: MessageUpdateType.Stream, token: "partial" }],
		});

		expect(isAssistantGenerationTerminal(message)).toBe(true);
		expect(isConversationGenerationActive([message])).toBe(false);
	});

	// Edge cases that drive the streaming UI state (stop button, resume) and that
	// P3b's rewrite must preserve.

	test("an assistant message with no updates at all is non-terminal (still generating)", () => {
		// A freshly-created assistant message before any terminal marker lands.
		const message = assistantMessage({ updates: [] });
		expect(isAssistantGenerationTerminal(message)).toBe(false);
		expect(isConversationGenerationActive([message])).toBe(true);
	});

	test("an assistant message with undefined updates is non-terminal", () => {
		const message = assistantMessage({ updates: undefined });
		expect(isAssistantGenerationTerminal(message)).toBe(false);
	});

	test("a missing / non-assistant message is treated as terminal", () => {
		expect(isAssistantGenerationTerminal(undefined)).toBe(true);
		expect(
			isAssistantGenerationTerminal({
				from: "user",
				id: "u1" as Message["id"],
				content: "hi",
				children: [],
			})
		).toBe(true);
	});

	test("an empty conversation is not active", () => {
		expect(isConversationGenerationActive([])).toBe(false);
	});

	test("a conversation with no assistant message is not active", () => {
		expect(
			isConversationGenerationActive([
				{ from: "user", id: "u1" as Message["id"], content: "hi", children: [] },
			])
		).toBe(false);
	});

	test("activeness is decided by the LAST assistant message, not an earlier one", () => {
		const earlierDone = assistantMessage({
			id: "a1" as Message["id"],
			updates: [{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished }],
		});
		const latestRunning = assistantMessage({
			id: "a2" as Message["id"],
			updates: [{ type: MessageUpdateType.Stream, token: "still going" }],
		});
		expect(isConversationGenerationActive([earlierDone, latestRunning])).toBe(true);

		const latestDone = assistantMessage({
			id: "a2" as Message["id"],
			updates: [{ type: MessageUpdateType.FinalAnswer, text: "done", interrupted: false }],
		});
		expect(isConversationGenerationActive([latestRunning, latestDone])).toBe(false);
	});

	test("interrupted wins even without any terminal update present", () => {
		const message = assistantMessage({ interrupted: true, updates: undefined });
		expect(isAssistantGenerationTerminal(message)).toBe(true);
	});

	// A parked-and-resumed turn (the wait tool) has a lifecycle: every park
	// stamps `finished`, every resume stamps a new `started`. The LAST lifecycle
	// event decides — "ever finished" would freeze the message at its first park.

	test("a resume after a park makes the message active again", () => {
		const message = assistantMessage({
			updates: [
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Started },
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Started },
				{ type: MessageUpdateType.Stream, token: "resumed output" },
			],
		});
		expect(isAssistantGenerationTerminal(message)).toBe(false);
		expect(isConversationGenerationActive([message])).toBe(true);
	});

	test("a turn parked again after a resume reads terminal until the next start", () => {
		const message = assistantMessage({
			updates: [
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Started },
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Started },
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
			],
		});
		expect(isAssistantGenerationTerminal(message)).toBe(true);
	});

	test("a final answer after the last start is terminal", () => {
		const message = assistantMessage({
			updates: [
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Started },
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Started },
				{ type: MessageUpdateType.FinalAnswer, text: "done", interrupted: false },
			],
		});
		expect(isAssistantGenerationTerminal(message)).toBe(true);
	});
});

describe("turn state as the authoritative liveness", () => {
	const state = (
		st: "running" | "waiting" | "awaiting_input" | "done" | "failed",
		extras: { until?: number; reason?: string } = {}
	) => ({
		type: MessageUpdateType.TurnState as const,
		state: st,
		serverNow: Date.now(),
		...extras,
	});

	test("turnStateOf returns the LAST turn state the message carries", () => {
		const message = assistantMessage({
			updates: [
				state("running"),
				state("waiting", { until: Date.now() + 60_000 }),
				state("running"),
			],
		});
		expect(turnStateOf(message)?.state).toBe("running");
		expect(turnStateOf(assistantMessage({ updates: [] }))).toBeUndefined();
	});

	test("lastFailedTurnId picks the last banner-rendering message, skipping empty reasons", () => {
		const failed = (id: string, reason?: string) =>
			assistantMessage({ id: id as Message["id"], updates: [state("failed", { reason })] });
		const messages = [
			assistantMessage({ id: "user-1" as Message["id"], from: "user", content: "hi" }),
			failed("a-1", "provider refused"),
			failed("a-2"), // an older galopin's empty reason renders no banner
			failed("a-3", "provider refused again"),
		];
		expect(lastFailedTurnId(messages)).toBe("a-3");
		expect(failedTurnReasonOf(messages[1])).toBe("provider refused");
		expect(failedTurnReasonOf(messages[2])).toBeUndefined();
		expect(lastFailedTurnId([messages[0]])).toBeUndefined();
		expect(lastFailedTurnId([])).toBeUndefined();
	});

	test("only a running turn is non-terminal for UI purposes", () => {
		expect(isAssistantGenerationTerminal(assistantMessage({ updates: [state("running")] }))).toBe(
			false
		);
		for (const st of ["waiting", "awaiting_input", "done", "failed"] as const) {
			expect(isAssistantGenerationTerminal(assistantMessage({ updates: [state(st)] }))).toBe(true);
		}
	});

	test("the state wins over legacy lifecycle statuses when both are present", () => {
		// A parked run stamps `finished` after the waiting transition; the state,
		// not the status, is the truth.
		const message = assistantMessage({
			updates: [
				state("waiting", { until: Date.now() + 60_000, reason: "job" }),
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
			],
		});
		expect(turnStateOf(message)?.state).toBe("waiting");
		expect(isAssistantGenerationTerminal(message)).toBe(true);
		expect(isTurnSubscribable(message)).toBe(true);
	});

	test("running, waiting and awaiting_input turns are subscribable; ended ones are not", () => {
		for (const st of ["running", "waiting", "awaiting_input"] as const) {
			expect(isTurnSubscribable(assistantMessage({ updates: [state(st)] }))).toBe(true);
		}
		for (const st of ["done", "failed"] as const) {
			expect(isTurnSubscribable(assistantMessage({ updates: [state(st)] }))).toBe(false);
		}
	});

	test("an interrupted message is neither active nor subscribable, whatever its state", () => {
		const message = assistantMessage({ interrupted: true, updates: [state("running")] });
		expect(isAssistantGenerationTerminal(message)).toBe(true);
		expect(isTurnSubscribable(message)).toBe(false);
	});

	test("messages without a turn state fall back to the legacy lifecycle", () => {
		const legacyLive = assistantMessage({
			updates: [{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Started }],
		});
		expect(isTurnSubscribable(legacyLive)).toBe(true);
		const legacyDone = assistantMessage({
			updates: [{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished }],
		});
		expect(isTurnSubscribable(legacyDone)).toBe(false);
	});
});

describe("createReattachGuard", () => {
	test("attaches at once the first time and after progress", () => {
		const guard = createReattachGuard(1000, 30_000);
		const message = assistantMessage({ generationId: "g1", materializedSeq: 3 });
		expect(guard.delayFor(message, 0)).toBe(0);
		guard.ended(message, 0);
		const moved = assistantMessage({ generationId: "g1", materializedSeq: 5 });
		expect(guard.delayFor(moved, 1)).toBe(0);
	});

	test("backs off exponentially when a re-attach ends with nothing new", () => {
		const guard = createReattachGuard(1000, 4000);
		const message = assistantMessage({ generationId: "g1", materializedSeq: 3 });
		guard.ended(message, 0);
		expect(guard.delayFor(message, 100)).toBe(900);
		expect(guard.delayFor(message, 1000)).toBe(0);
		guard.ended(message, 1000);
		expect(guard.delayFor(message, 1000)).toBe(2000);
		guard.ended(message, 3000);
		guard.ended(message, 7000);
		guard.ended(message, 11_000);
		expect(guard.delayFor(message, 11_000)).toBe(4000);
	});

	test("reset forgets the last re-attach", () => {
		const guard = createReattachGuard();
		const message = assistantMessage({ generationId: "g1" });
		guard.ended(message, 0);
		guard.reset();
		expect(guard.delayFor(message, 1)).toBe(0);
	});
});

describe("reconcileWithTurnState", () => {
	const snapshot = (status: "done" | "failed" | "running", error?: string) => ({
		messageId: "assistant-1" as Message["id"],
		status,
		serverNow: 1,
		...(error ? { error } : {}),
	});

	test("a stale awaiting_input message becomes failed when the server says failed", () => {
		const message = assistantMessage({
			generationId: "a",
			updates: [
				{ type: MessageUpdateType.TurnState, state: "awaiting_input", serverNow: 0 },
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
			],
		});
		expect(isTurnSubscribable(message)).toBe(true);
		const fixed = reconcileWithTurnState(message, snapshot("failed", "401 invalid API key"));
		expect(isTurnSubscribable(fixed)).toBe(false);
		expect(turnStateOf(fixed)?.state).toBe("failed");
		expect(streamErrorOf(fixed)).toBe("401 invalid API key");
	});

	test("leaves agreeing, running, other-message and interrupted messages alone", () => {
		const failed = assistantMessage({
			updates: [{ type: MessageUpdateType.TurnState, state: "failed", serverNow: 0 }],
		});
		expect(reconcileWithTurnState(failed, snapshot("failed"))).toBe(failed);
		const running = assistantMessage();
		expect(reconcileWithTurnState(running, snapshot("running"))).toBe(running);
		expect(
			reconcileWithTurnState(running, {
				...snapshot("failed"),
				messageId: "other" as Message["id"],
			})
		).toBe(running);
		const stopped = assistantMessage({ interrupted: true });
		expect(reconcileWithTurnState(stopped, snapshot("failed"))).toBe(stopped);
	});
});
