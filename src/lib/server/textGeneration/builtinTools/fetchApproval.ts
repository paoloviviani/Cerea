import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { ElicitationRequestPayload } from "$lib/types/McpElicitation";
import type { ElicitationSink } from "$lib/server/mcp/elicitation";
import { MessageElicitationUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import { WEB_FETCH_TOOL_NAME } from "./fetchUrlUtils";

/** Domain approval scopes offered by the "ask per domain" web-fetch policy. */
export const FETCH_APPROVAL_SCOPE_FIELD = "scope";
export const FETCH_APPROVAL_ONCE = "once";
export const FETCH_APPROVAL_CONVERSATION = "conversation";

/**
 * Parks a `web_fetch` call on a domain the "ask per domain" policy
 * (`Settings.webFetchPolicy === "ask-domain"`) has not yet approved. Reuses
 * the same durable-elicitation storage and UI as `ask_user_question` and MCP
 * elicitations; the resume path (`resumeElicitation.ts`) is what makes this
 * one different — it re-issues the fetch rather than just returning the
 * answer as text.
 */
export async function openFetchApprovalPrompt({
	sink,
	toolUuid,
	toolCallId,
	messageId,
	url,
}: {
	sink: ElicitationSink;
	toolUuid: string;
	toolCallId: string;
	messageId: string;
	url: string;
}): Promise<{ opened: boolean; reason?: string }> {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return { opened: false, reason: "not a valid URL" };
	}

	const elicitationId = randomUUID();
	const request: ElicitationRequestPayload = {
		elicitationId,
		server: WEB_FETCH_TOOL_NAME,
		mode: "form",
		message: `The assistant wants to read ${hostname}, a page neither you nor a search result supplied:\n${url}`,
		fields: [
			{
				kind: "select",
				name: FETCH_APPROVAL_SCOPE_FIELD,
				title: "Allow this fetch?",
				required: true,
				multiple: false,
				options: [
					{ value: FETCH_APPROVAL_ONCE, label: "Allow this one fetch" },
					{
						value: FETCH_APPROVAL_CONVERSATION,
						label: "Allow this domain for the rest of the conversation",
					},
				],
			},
		],
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
			pending: { kind: "fetch-approval", url, messageId, toolCallId, toolUuid },
			createdAt: now,
			updatedAt: now,
		});
	} catch (err) {
		logger.error({ err }, "[web_fetch] failed to record domain-approval prompt");
		return { opened: false, reason: "could not be recorded" };
	}

	sink.emit({
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Request,
		request,
		toolUuid,
	});
	return { opened: true };
}
