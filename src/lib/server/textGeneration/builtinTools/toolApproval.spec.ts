import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import type { MessageUpdate } from "$lib/types/MessageUpdate";
import {
	isMessageElicitationRequestUpdate,
	isMessageElicitationResolvedUpdate,
} from "$lib/utils/messageUpdates";

await ready;

const { openToolApprovalPrompt } = await import("./toolApproval");

describe("openToolApprovalPrompt (ADR 0075)", () => {
	it("records a durable prompt naming the tool and its arguments, offering once/conversation scopes", async () => {
		const conversationId = new ObjectId();
		const updates: MessageUpdate[] = [];

		const opened = await openToolApprovalPrompt({
			sink: { conversationId, emit: (u) => updates.push(u) },
			toolUuid: "call-uuid",
			toolCallId: "call-1",
			messageId: "message-1",
			tool: "web_fetch",
			args: { url: "https://unseen.test/page" },
			queue: [],
		});

		expect(opened).toEqual({ opened: true });

		const emitted = updates.find(isMessageElicitationRequestUpdate);
		expect(emitted?.toolUuid).toBe("call-uuid");
		expect(emitted?.request.toolApproval).toEqual({
			tool: "web_fetch",
			args: { url: "https://unseen.test/page" },
		});
		expect(emitted?.request.fields?.[0]).toMatchObject({
			kind: "select",
			required: true,
			options: [
				{ value: "once", label: expect.stringContaining("one call") },
				{ value: "conversation", label: expect.stringContaining("rest of the conversation") },
			],
		});
		// Unlike the durable ask/mcp prompts, this one fails closed: a deadline
		// is set so the sweeper can deny it if nobody answers.
		expect(emitted?.expiresAt).toBeGreaterThan(Date.now());
		expect(updates.find(isMessageElicitationResolvedUpdate)).toBeUndefined();

		const elicitationId = emitted?.request.elicitationId;
		const stored = await collections.mcpElicitations.findOne({ elicitationId });
		expect(stored?.pending).toEqual({
			kind: "tool-approval",
			tool: "web_fetch",
			args: { url: "https://unseen.test/page" },
			queue: [],
			messageId: "message-1",
			toolCallId: "call-1",
			toolUuid: "call-uuid",
		});
		expect(stored?.status).toBe("pending");
		expect(stored?.expiresAt).toBeInstanceOf(Date);
	});

	it("carries the mcp server/tool and the queue of calls waiting behind this one", async () => {
		const conversationId = new ObjectId();
		const updates: MessageUpdate[] = [];
		const queue = [
			{
				toolUuid: "u2",
				toolCallId: "c2",
				tool: "hf:search",
				args: { q: "cats" },
				mcp: { server: "hf", toolName: "search" },
			},
		];

		const opened = await openToolApprovalPrompt({
			sink: { conversationId, emit: (u) => updates.push(u) },
			toolUuid: "u1",
			toolCallId: "c1",
			messageId: "message-1",
			tool: "hf:get_weather",
			args: { city: "Paris" },
			mcp: { server: "hf", toolName: "get_weather" },
			queue,
		});

		expect(opened.opened).toBe(true);
		// Scoped by the elicitationId this call actually minted: `toolUuid: "u1"`
		// is a placeholder reused across unrelated spec files sharing this
		// database, and a query without it can pick up someone else's row.
		const elicitationId = updates.find(isMessageElicitationRequestUpdate)?.request.elicitationId;
		const stored = await collections.mcpElicitations.findOne({ elicitationId });
		expect(stored?.pending).toMatchObject({
			mcp: { server: "hf", toolName: "get_weather" },
			queue,
		});
	});

	it("records who opened it, so a deny-timeout sweep can resume with no request behind it", async () => {
		const conversationId = new ObjectId();
		const userId = new ObjectId();
		const updates: MessageUpdate[] = [];

		await openToolApprovalPrompt({
			sink: { conversationId, emit: (u) => updates.push(u) },
			toolUuid: "u3",
			toolCallId: "c3",
			messageId: "message-1",
			tool: "web_fetch",
			args: {},
			queue: [],
			userId,
			sessionId: "session-1",
		});

		const elicitationId = updates.find(isMessageElicitationRequestUpdate)?.request.elicitationId;
		const stored = await collections.mcpElicitations.findOne({ elicitationId });
		const pending = stored?.pending?.kind === "tool-approval" ? stored.pending : undefined;
		expect(pending?.userId?.toString()).toBe(userId.toString());
		expect(pending).toMatchObject({ sessionId: "session-1" });
	});
});
