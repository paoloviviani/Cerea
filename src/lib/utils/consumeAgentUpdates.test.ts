import { describe, expect, it, vi } from "vitest";
import { consumeAgentUpdates } from "./consumeAgentUpdates";
import { isConversationGenerationActive } from "./generationState";
import {
	MessageElicitationUpdateType,
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageElicitationRequestUpdate,
} from "$lib/types/MessageUpdate";
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";
import { ToolResultStatus } from "$lib/types/Tool";
import type { Message } from "$lib/types/Message";

async function* of(frames: AgentStreamUpdate[]): AsyncGenerator<AgentStreamUpdate> {
	for (const frame of frames) yield frame;
}

const run = async (frames: AgentStreamUpdate[], isAborted = () => false) => {
	const messages: Message[] = [];
	await consumeAgentUpdates(of(frames), messages, {
		isAborted,
		onAbort: vi.fn(),
		onTurnEvent: vi.fn(),
	});
	return messages;
};

const user = (text: string): AgentStreamUpdate => ({ type: "user", text });
const token = (text: string): AgentStreamUpdate => ({
	type: MessageUpdateType.Stream,
	token: text,
});
const call = (uuid: string, name = "bash"): AgentStreamUpdate => ({
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Call,
	uuid,
	call: { name, parameters: { command: "ls" } },
});
/** opencode's `pending` state: the name is known, the arguments are still
 * streaming, so the input is empty. */
const pendingCall = (uuid: string, name = "bash"): AgentStreamUpdate => ({
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Call,
	uuid,
	call: { name, parameters: {} },
});
const filledCall = (uuid: string, name = "bash", command: string): AgentStreamUpdate => ({
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Call,
	uuid,
	call: { name, parameters: { command } },
});
const result = (uuid: string, name = "bash"): AgentStreamUpdate => ({
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Result,
	uuid,
	result: {
		status: ToolResultStatus.Success,
		call: { name, parameters: { command: "ls" } },
		outputs: [{ text: "a.txt" }],
		display: true,
	},
});
const running = (): AgentStreamUpdate => ({
	type: MessageUpdateType.TurnState,
	state: "running",
	serverNow: 0,
});
const done = (): AgentStreamUpdate => ({
	type: MessageUpdateType.TurnState,
	state: "done",
	serverNow: 0,
});

describe("consumeAgentUpdates", () => {
	it("folds a replayed log into chat turns", async () => {
		const messages = await run([
			user("fix the test"),
			token("Let me "),
			token("look."),
			call("t1"),
			result("t1"),
			token("Done."),
			done(),
		]);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ from: "user", content: "fix the test" });
		const assistant = messages[1];
		expect(assistant.from).toBe("assistant");
		expect(assistant.content).toBe("Let me look.Done.");
		const updates = assistant.updates ?? [];
		expect(updates).toHaveLength(5);
		expect(updates[0]).toMatchObject({ type: "stream", token: "Let me look." });
		expect(updates[1]).toMatchObject({ type: "tool", subtype: "call", uuid: "t1" });
		expect(updates[2]).toMatchObject({ type: "tool", subtype: "result", uuid: "t1" });
		expect(updates[3]).toMatchObject({ type: "stream", token: "Done." });
		expect(updates[4]).toMatchObject({ type: "turnState", state: "done" });
		// The turn ended: the transcript is not live.
		expect(isConversationGenerationActive(messages)).toBe(false);
	});

	it("stamps machineMessageId from a preceding messageBoundary frame, on both sides of a turn", async () => {
		const messages = await run([
			{ type: "messageBoundary", role: "user", messageId: "wire-u1" },
			user("fix the test"),
			{ type: "messageBoundary", role: "assistant", messageId: "wire-a1" },
			token("on it"),
			done(),
		]);
		expect(messages[0]).toMatchObject({ from: "user", machineMessageId: "wire-u1" });
		expect(messages[1]).toMatchObject({ from: "assistant", machineMessageId: "wire-a1" });
	});

	it("leaves machineMessageId unset when no boundary frame preceded the message", async () => {
		const messages = await run([user("fix the test"), token("on it"), done()]);
		expect(messages[0].machineMessageId).toBeUndefined();
		expect(messages[1].machineMessageId).toBeUndefined();
	});

	it("puts a user frame's attachments on the user message, and nothing else moves", async () => {
		const files = [{ type: "hash" as const, value: "abc", mime: "image/png", name: "shot.png" }];
		const messages = await run([
			{ type: "user", text: "look at this", messageId: "m1", files },
			token("Seen."),
			done(),
		]);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ from: "user", content: "look at this", files });
		expect(messages[1]).toMatchObject({ from: "assistant", content: "Seen." });
		expect(messages[1].files).toBeUndefined();
	});

	it("pairs a live tool's running and completed frames once", async () => {
		const messages = await run([user("run it"), running(), call("t1"), result("t1"), done()]);
		const updates = messages[1].updates ?? [];
		const toolFrames = updates.filter((u) => u.type === MessageUpdateType.Tool);
		expect(toolFrames).toHaveLength(2);
		expect(toolFrames[0]).toMatchObject({ subtype: "call" });
		expect(toolFrames[1]).toMatchObject({ subtype: "result" });
	});

	it("a filled Call replaces the pending Call's empty input, in place", async () => {
		const messages = await run([
			user("run it"),
			running(),
			pendingCall("t1"),
			filledCall("t1", "bash", "ls -la"),
			result("t1"),
			done(),
		]);
		const toolFrames = (messages[1].updates ?? []).filter((u) => u.type === MessageUpdateType.Tool);
		expect(toolFrames).toHaveLength(2);
		expect(toolFrames[0]).toMatchObject({
			subtype: "call",
			call: { name: "bash", parameters: { command: "ls -la" } },
		});
		expect(toolFrames[1]).toMatchObject({ subtype: "result" });
	});

	it("an empty later Call never regresses a filled one", async () => {
		const messages = await run([
			user("run it"),
			pendingCall("t1"),
			filledCall("t1", "bash", "git status"),
			pendingCall("t1"),
			done(),
		]);
		const toolFrames = (messages[1].updates ?? []).filter((u) => u.type === MessageUpdateType.Tool);
		expect(toolFrames).toHaveLength(1);
		expect(toolFrames[0]).toMatchObject({
			call: { name: "bash", parameters: { command: "git status" } },
		});
	});

	it("a Result with no prior Call still synthesizes one", async () => {
		const messages = await run([user("run it"), result("t1"), done()]);
		const toolFrames = (messages[1].updates ?? []).filter((u) => u.type === MessageUpdateType.Tool);
		expect(toolFrames).toHaveLength(2);
		expect(toolFrames[0]).toMatchObject({
			subtype: "call",
			call: { name: "bash", parameters: { command: "ls" } },
		});
	});

	it("ignores a re-derived call for a tool that already closed", async () => {
		const messages = await run([user("run it"), call("t1"), result("t1"), call("t1"), done()]);
		const updates = messages[1].updates ?? [];
		expect(updates.filter((u) => u.type === MessageUpdateType.Tool)).toHaveLength(2);
	});

	it("keeps each plan snapshot, versions distinct", async () => {
		const plan = (version: number, status: "pending" | "completed"): AgentStreamUpdate => ({
			type: MessageUpdateType.Plan,
			uuid: "agent-plan",
			goal: "ship it",
			version,
			steps: [{ step: "a", status }],
		});
		const messages = await run([
			user("plan it"),
			running(),
			plan(1, "pending"),
			plan(2, "completed"),
		]);
		const plans = (messages[1].updates ?? []).filter((u) => u.type === MessageUpdateType.Plan);
		expect(plans).toHaveLength(2);
		expect(plans[0].version).toBe(1);
		expect(plans[1].version).toBe(2);
	});

	it("turns a mid-run mount live without splitting the trailing bubble", async () => {
		const messages = await run([user("go"), token("partial "), running(), token("more")]);
		expect(messages).toHaveLength(2);
		expect(messages[1].content).toBe("partial more");
		const updates = messages[1].updates ?? [];
		expect(updates.at(-2)).toMatchObject({ type: "turnState", state: "running" });
		// The trailing message is the running turn, so the view renders live.
		expect(isConversationGenerationActive(messages)).toBe(true);
	});

	it("starts a fresh bubble for a turn whose echo already arrived", async () => {
		const messages = await run([user("go"), running()]);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({ from: "assistant", content: "" });
		expect(isConversationGenerationActive(messages)).toBe(true);
	});

	it("settles an approval card on the message that asked", async () => {
		const request: MessageElicitationRequestUpdate = {
			type: MessageUpdateType.Elicitation,
			subtype: MessageElicitationUpdateType.Request,
			request: {
				elicitationId: "p1",
				server: "opencode",
				mode: "form",
				message: "want to run",
				toolApproval: { tool: "npm test", args: {} },
			},
		};
		const resolved = {
			type: MessageUpdateType.Elicitation,
			subtype: MessageElicitationUpdateType.Resolved,
			elicitationId: "p1",
			action: "accept",
			resolution: "user",
		} as const;
		const messages = await run([user("deploy"), running(), token("working"), request, resolved]);
		expect(messages).toHaveLength(2);
		const updates = messages[1].updates ?? [];
		const kinds = updates.map((u) => `${u.type}:${(u as { subtype?: string }).subtype ?? "-"}`);
		// The turn state leads (the turn opened before the agent spoke); the
		// resolution settles the request in place, never as a second card.
		expect(kinds).toEqual([
			"turnState:-",
			"stream:-",
			"elicitation:request",
			"elicitation:resolved",
		]);
	});

	it("flushes buffered tokens before folding a non-stream frame", async () => {
		const messages = await run([user("go"), token("hal"), call("t1")]);
		// The token landed on the message even though the fold moved straight
		// on to the tool card: text never reads cut mid-word beside the tool.
		expect(messages[1].content).toBe("hal");
	});

	it("commits the buffer when aborted mid-stream", async () => {
		const onAbort = vi.fn();
		const messages: Message[] = [];
		let checked = 0;
		await consumeAgentUpdates(of([user("go"), token("half "), token("!")]), messages, {
			isAborted: () => (checked += 1) > 2,
			onAbort,
			onTurnEvent: vi.fn(),
		});
		expect(onAbort).toHaveBeenCalled();
		// The tokens buffered before the abort point are committed; the frame
		// the abort check saw first is not folded.
		expect(messages).toHaveLength(2);
		expect(messages[1].content).toBe("half ");
	});

	describe("the bridge's historyDone marker", () => {
		it("commits the buffered tail before the callback, and leaves the transcript untouched", async () => {
			const messages: Message[] = [];
			const seen: number[] = [];
			await consumeAgentUpdates(
				of([user("go"), token("tail"), { type: "historyDone" }]),
				messages,
				{
					isAborted: () => false,
					onAbort: vi.fn(),
					onTurnEvent: vi.fn(),
					onHistoryDone: () => seen.push(messages.length),
				}
			);
			// The callback fires once, with the last token already on the
			// message: the view renders a whole transcript, never one that is
			// missing its final buffered burst.
			expect(seen).toEqual([2]);
			expect(messages[1]).toMatchObject({ from: "assistant", content: "tail" });
		});

		it("is a silent no-op without the callback, and fires again on a reconnect", async () => {
			const messages: Message[] = [];
			const onHistoryDone = vi.fn();
			await consumeAgentUpdates(
				of([{ type: "historyDone" }, user("hello"), token("hi"), done(), { type: "historyDone" }]),
				messages,
				{ isAborted: () => false, onAbort: vi.fn(), onTurnEvent: vi.fn(), onHistoryDone }
			);
			// The marker never opens or closes a turn; the view decides what
			// a repeat means (a reconnected stream already showing the
			// transcript, so usually nothing).
			expect(onHistoryDone).toHaveBeenCalledTimes(2);
			expect(messages).toHaveLength(2);
			expect(messages[1].content).toBe("hi");
		});
	});

	describe("the bridge's historyMeta frame", () => {
		it("reports the snapshot's paging facts without touching the transcript", async () => {
			const messages: Message[] = [];
			const onHistoryMeta = vi.fn();
			await consumeAgentUpdates(
				of([user("go"), { type: "historyMeta", hasMore: true, before: "msg_1" }]),
				messages,
				{ isAborted: () => false, onAbort: vi.fn(), onTurnEvent: vi.fn(), onHistoryMeta }
			);
			expect(onHistoryMeta).toHaveBeenCalledTimes(1);
			expect(onHistoryMeta).toHaveBeenCalledWith({
				type: "historyMeta",
				hasMore: true,
				before: "msg_1",
			});
			expect(messages).toHaveLength(1);
		});

		it("is a silent no-op without the callback", async () => {
			const messages = await run([{ type: "historyMeta", hasMore: false }]);
			expect(messages).toHaveLength(0);
		});
	});

	describe("usage and compaction: a side channel that never touches turn structure (M3)", () => {
		it("calls onUsage without opening a turn, disturbing the pending message, or affecting the transcript", async () => {
			const messages: Message[] = [];
			const onUsage = vi.fn();
			await consumeAgentUpdates(of([{ type: "usage", usage: { used: 10, max: 100 } }]), messages, {
				isAborted: () => false,
				onAbort: vi.fn(),
				onTurnEvent: vi.fn(),
				onUsage,
			});
			expect(onUsage).toHaveBeenCalledWith({ used: 10, max: 100 });
			// No message was opened or closed — a bare usage frame with no
			// surrounding turn leaves the transcript exactly empty.
			expect(messages).toHaveLength(0);
		});

		it("calls onCompaction the same way, and interleaved with an ordinary turn neither disturbs the other", async () => {
			const onUsage = vi.fn();
			const onCompaction = vi.fn();
			const messages: Message[] = [];
			await consumeAgentUpdates(
				of([
					user("compact please"),
					running(),
					token("On it."),
					{ type: "usage", usage: { used: 50, max: 100 } },
					{ type: "compaction", auto: false },
					done(),
				]),
				messages,
				{ isAborted: () => false, onAbort: vi.fn(), onTurnEvent: vi.fn(), onUsage, onCompaction }
			);
			expect(onUsage).toHaveBeenCalledWith({ used: 50, max: 100 });
			expect(onCompaction).toHaveBeenCalledWith({ type: "compaction", auto: false });

			// The ordinary turn folded exactly as it would without the side
			// channel interleaved: one user message, one assistant message
			// carrying only the turn's own updates (stream + turn state) —
			// the usage/compaction frames left no trace on it.
			expect(messages).toHaveLength(2);
			expect(messages[0]).toMatchObject({ from: "user", content: "compact please" });
			const assistant = messages[1];
			expect(assistant.content).toBe("On it.");
			const kinds = (assistant.updates ?? []).map((u) => u.type);
			expect(kinds).toEqual(["turnState", "stream", "turnState"]);
		});

		it("a missing onUsage/onCompaction callback is a silent no-op, not a throw", async () => {
			const messages: Message[] = [];
			await expect(
				consumeAgentUpdates(
					of([
						{ type: "usage", usage: { used: 1 } },
						{ type: "compaction", auto: true },
					]),
					messages,
					{ isAborted: () => false, onAbort: vi.fn(), onTurnEvent: vi.fn() }
				)
			).resolves.toBeUndefined();
		});
	});

	describe("a message another session wrote", () => {
		it("stamps sentBy on the user message, and only on that one", async () => {
			const sentBy = { sessionId: "ses_a", title: "Docs agent", hop: 1 };
			const messages = await run([
				{ type: "messageBoundary", role: "user", messageId: "u1", sentBy },
				user("please review"),
				running(),
				token("On it."),
				done(),
				{ type: "messageBoundary", role: "user", messageId: "u2" },
				user("thanks"),
			]);
			expect(messages[0]).toMatchObject({ from: "user", sentBy, machineMessageId: "u1" });
			expect(messages[2]).toMatchObject({ from: "user", content: "thanks" });
			expect(messages[2].sentBy).toBeUndefined();
		});

		it("survives opencode re-announcing an earlier message before the text arrives", async () => {
			const sentBy = { sessionId: "ses_a", title: "Docs agent", hop: 2 };
			const messages = await run([
				{ type: "messageBoundary", role: "user", messageId: "u1" },
				user("first"),
				running(),
				{ type: "messageBoundary", role: "user", messageId: "u2", sentBy },
				{ type: "messageBoundary", role: "user", messageId: "u1" },
				user("from the other agent"),
				done(),
			]);
			const sent = messages.find((m) => m.content === "from the other agent");
			expect(sent).toMatchObject({ sentBy, machineMessageId: "u2" });
		});
	});

	describe("the mid-turn fold (a steer)", () => {
		const boundary = (role: "user" | "assistant", messageId: string): AgentStreamUpdate => ({
			type: "messageBoundary",
			role,
			messageId,
		});
		const lastState = (message: Message) =>
			[...(message.updates ?? [])].reverse().find((u) => u.type === "turnState");

		// The order opencode 1.18.32 really emitted (captured from a live
		// `opencode serve`, big-pickle): user1, busy, assistant A, then a second
		// prompt sent mid-turn — user2 lands BEFORE A finishes its step, A's
		// parts keep arriving, and the answer is a NEW assistant message B
		// (parentID = user2) behind a repeated `busy`, with NO idle in between.
		// Repeated `message.updated` events re-emit boundaries for ids already
		// seen (user1 twice, A three times).
		const captured: AgentStreamUpdate[] = [
			boundary("user", "u1"),
			user("count to forty"),
			running(),
			boundary("assistant", "A"),
			boundary("user", "u1"),
			boundary("user", "u2"),
			user("also say STEERED"),
			running(),
			token("1 2 3 "),
			boundary("assistant", "A"),
			boundary("assistant", "A"),
			running(),
			boundary("assistant", "B"),
			token("STEERED"),
			boundary("assistant", "B"),
			running(),
			done(),
		];

		it("renders the steer inside one continuous turn", async () => {
			const messages = await run(captured);

			expect(messages.map((m) => [m.from, m.content])).toEqual([
				["user", "count to forty"],
				["assistant", "1 2 3 "],
				["user", "also say STEERED"],
				["assistant", "STEERED"],
			]);
			// The step in flight stayed with its own bubble, not a stray third one.
			expect(messages[1].machineMessageId).toBe("A");
			expect(messages[3].machineMessageId).toBe("B");
			// Settled where the answer took over; the answer carries the turn's end.
			expect(lastState(messages[1])).toMatchObject({ state: "done" });
			expect(lastState(messages[3])).toMatchObject({ state: "done" });
			expect(isConversationGenerationActive(messages)).toBe(false);
		});

		it("never reads idle across the seam", async () => {
			// Every prefix of the capture short of its end is a live turn, the
			// cut between A's settling and B's first token included.
			for (let cut = 1; cut < captured.length; cut += 1) {
				const messages = await run(captured.slice(0, cut));
				if (messages.some((m) => m.from === "assistant")) {
					expect(isConversationGenerationActive(messages), `cut ${cut}`).toBe(true);
				}
			}
		});

		it("a follow-up whose running frame beats its echo is a new turn, not a steer", async () => {
			const messages = await run([
				user("first"),
				running(),
				token("one"),
				done(),
				// the daemon's live order: turn_started, then the timeline echo
				running(),
				user("second"),
				token("two"),
				done(),
			]);

			expect(messages.map((m) => [m.from, m.content])).toEqual([
				["user", "first"],
				["assistant", "one"],
				["user", "second"],
				["assistant", "two"],
			]);
		});

		it("a steer that arrives when the turn is already over stays an ordinary next turn", async () => {
			const messages = await run([user("a"), running(), token("x"), done(), user("b"), token("y")]);

			expect(messages.map((m) => m.from)).toEqual(["user", "assistant", "user", "assistant"]);
			expect(lastState(messages[1])).toMatchObject({ state: "done" });
		});
	});

	describe("background task markers", () => {
		const backgroundRunning = (taskId: string, callId = "call_task1"): AgentStreamUpdate => ({
			type: MessageUpdateType.BackgroundTask,
			taskId,
			callId,
			state: "running",
			summary: "Background task started: Survey the repo",
		});
		const backgroundDone = (taskId: string): AgentStreamUpdate => ({
			type: MessageUpdateType.BackgroundTask,
			taskId,
			state: "completed",
			summary: "Background task completed: Survey the repo",
			text: "The repo holds a SvelteKit app.",
			automatic: true,
		});

		it("opens a marker row on the running turn", async () => {
			const messages = await run([
				user("delegate this"),
				running(),
				call("call_task1", "task"),
				backgroundRunning("ses_child1"),
				token("Launched."),
				done(),
			]);
			expect(messages).toHaveLength(2);
			const updates = messages[1].updates ?? [];
			expect(updates).toContainEqual(
				expect.objectContaining({
					type: "backgroundTask",
					taskId: "ses_child1",
					state: "running",
				})
			);
		});

		it("folds a later synthetic completion into the same marker, in place", async () => {
			const messages = await run([
				user("delegate this"),
				running(),
				call("call_task1", "task"),
				backgroundRunning("ses_child1"),
				done(),
				// A turn later, the injected result arrives for the same child.
				user("anything new?"),
				running(),
				token("Checking."),
				backgroundDone("ses_child1"),
				done(),
			]);
			const markers = messages.flatMap((m) =>
				((m.updates ?? []) as AgentStreamUpdate[]).filter(
					(u) => u.type === MessageUpdateType.BackgroundTask
				)
			);
			// One marker per child: the running row became the completed one.
			expect(markers).toHaveLength(1);
			expect(markers[0]).toMatchObject({
				taskId: "ses_child1",
				callId: "call_task1",
				state: "completed",
				automatic: true,
				text: "The repo holds a SvelteKit app.",
			});
			// The completion landed on the spawning turn's message, not the later one.
			expect(messages[1].updates).toContainEqual(
				expect.objectContaining({ type: "backgroundTask", state: "completed" })
			);
		});

		it("opens a fresh row for a completion nobody marked running", async () => {
			const messages = await run([user("hi"), running(), backgroundDone("ses_orphan"), done()]);
			const markers = (messages[1].updates ?? []).filter(
				(u) => u.type === MessageUpdateType.BackgroundTask
			);
			expect(markers).toHaveLength(1);
			expect(markers[0]).toMatchObject({ taskId: "ses_orphan", state: "completed" });
		});
	});
});
