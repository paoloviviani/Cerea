import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { ElicitationRequestPayload, QueuedApprovalCall } from "$lib/types/McpElicitation";
import type { ElicitationSink } from "$lib/server/mcp/elicitation";
import { getElicitationTimeoutMs } from "$lib/server/mcp/elicitationConfig";
import { MessageElicitationUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";

/** Scopes offered by the tool-approval card (ADR 0075). */
export const TOOL_APPROVAL_SCOPE_FIELD = "scope";
export const TOOL_APPROVAL_ONCE = "once";
export const TOOL_APPROVAL_CONVERSATION = "conversation";

/**
 * Parks a call gated by the global tool-approval policy
 * (`Settings.toolApprovalPolicy === "manual"`): `web_fetch` reading a page
 * neither the user nor `web_search` supplied, or any MCP tool. Reuses the
 * same durable-elicitation storage and UI as `ask_user_question` and MCP
 * elicitations; the resume path (`resumeElicitation.ts`) is what makes this
 * one different — it re-issues the call rather than just returning the
 * answer as text, and pops the next queued call once this one resolves.
 *
 * `expiresAt` is set (unlike the older per-tool prompts this replaces) so an
 * unanswered approval fails closed: the deny-timeout sweep
 * (`toolApprovalSweeper.ts`) denies it once the deadline passes, rather than
 * leaving the model's call parked forever.
 */
export async function openToolApprovalPrompt({
	sink,
	toolUuid,
	toolCallId,
	messageId,
	tool,
	args,
	mcp,
	queue,
	userId,
	sessionId,
}: {
	sink: ElicitationSink;
	toolUuid: string;
	toolCallId: string;
	messageId: string;
	/** Grant key: server-qualified (`"server:tool"`) for MCP, else the builtin name (`"web_fetch"`). */
	tool: string;
	args: Record<string, unknown>;
	mcp?: { server: string; toolName: string };
	queue: QueuedApprovalCall[];
	userId?: ObjectId;
	sessionId?: string;
}): Promise<{ opened: boolean; reason?: string }> {
	const elicitationId = randomUUID();
	const expiresAt = new Date(Date.now() + getElicitationTimeoutMs());
	const request: ElicitationRequestPayload = {
		elicitationId,
		server: tool,
		mode: "form",
		message: `The assistant wants to call ${tool}.`,
		fields: [
			{
				kind: "select",
				name: TOOL_APPROVAL_SCOPE_FIELD,
				title: "Allow this call?",
				required: true,
				multiple: false,
				options: [
					{ value: TOOL_APPROVAL_ONCE, label: "Allow this one call" },
					{
						value: TOOL_APPROVAL_CONVERSATION,
						label: "Allow this tool for the rest of the conversation",
					},
				],
			},
		],
		toolApproval: { tool, args },
	};
	const now = new Date();

	try {
		await collections.mcpElicitations.insertOne({
			_id: new ObjectId(),
			elicitationId,
			conversationId: sink.conversationId,
			...(sink.generationId ? { generationId: sink.generationId } : {}),
			status: "pending",
			request,
			expiresAt,
			pending: {
				kind: "tool-approval",
				tool,
				args,
				messageId,
				toolCallId,
				toolUuid,
				queue,
				...(mcp ? { mcp } : {}),
				...(userId ? { userId } : {}),
				...(sessionId ? { sessionId } : {}),
			},
			createdAt: now,
			updatedAt: now,
		});
	} catch (err) {
		logger.error({ err, tool }, "[tool-approval] failed to record prompt");
		return { opened: false, reason: "could not be recorded" };
	}

	sink.emit({
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Request,
		request,
		expiresAt: expiresAt.getTime(),
		toolUuid,
	});
	return { opened: true };
}
