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
});
