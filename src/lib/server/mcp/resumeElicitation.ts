import type { ObjectId } from "mongodb";
import { logger } from "$lib/server/logger";
import { callMcpTool, getMcpToolTimeoutMs } from "./httpClient";
import { getMcpServers } from "./registry";
import { openDurableElicitation, takeResumableElicitation } from "./elicitation";
import { ToolResultStatus } from "$lib/types/Tool";
import {
	MessageElicitationUpdateType,
	MessageToolUpdateType,
	MessageUpdateType,
} from "$lib/types/MessageUpdate";
import type { MessageUpdate } from "$lib/types/MessageUpdate";
import type { McpServerConfig } from "./httpClient";
import { ASK_USER_QUESTION_TOOL_NAME, answerToToolResult } from "$lib/server/askUserQuestion";
import {
	WEB_FETCH_TOOL_NAME,
	performFetch,
} from "$lib/server/textGeneration/builtinTools/webFetchTool";
import {
	openToolApprovalPrompt,
	TOOL_APPROVAL_CONVERSATION,
	TOOL_APPROVAL_SCOPE_FIELD,
} from "$lib/server/textGeneration/builtinTools/toolApproval";
import type { PendingToolApprovalCall, QueuedApprovalCall } from "$lib/types/McpElicitation";
import { collections } from "$lib/server/database";

/** One queued (or originally parked) tool-approval call, ready to run or to be denied. */
type ApprovableCall = Pick<QueuedApprovalCall, "tool" | "args" | "mcp">;

/** Refusal fed back to the model exactly like OpenWebUI's deny behavior. */
function toolApprovalDenied(toolUuid: string, tool: string): MessageUpdate {
	return {
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Error,
		uuid: toolUuid,
		message: `The user declined to run ${tool}.`,
	};
}

/**
 * Runs a call the tool-approval gate has already cleared — accepted just now,
 * or auto-cleared because an earlier item in the same queue granted this
 * exact tool "for the conversation". `web_fetch` re-issues through
 * `performFetch` (no builtin dispatch machinery involved, same as before);
 * an MCP call re-issues through `callMcpTool` directly. Never throws: every
 * failure becomes a Tool Error update, which the model reads and can recover
 * from.
 */
async function runApprovedCall(
	call: ApprovableCall,
	toolUuid: string,
	extraServers: McpServerConfig[],
	signal?: AbortSignal
): Promise<MessageUpdate> {
	if (!call.mcp) {
		const url = typeof call.args.url === "string" ? call.args.url : "";
		const { result } = await performFetch(url);
		return "error" in result
			? {
					type: MessageUpdateType.Tool,
					subtype: MessageToolUpdateType.Error,
					uuid: toolUuid,
					message: result.error,
				}
			: {
					type: MessageUpdateType.Tool,
					subtype: MessageToolUpdateType.Result,
					uuid: toolUuid,
					result: {
						status: ToolResultStatus.Success,
						call: { name: WEB_FETCH_TOOL_NAME, parameters: { url } },
						outputs: [{ text: result.resultText }] as unknown as Record<string, unknown>[],
						display: true,
					},
				};
	}

	const { mcp } = call;
	const server = [...getMcpServers(), ...extraServers].find((s) => s.name === mcp.server);
	if (!server) {
		return {
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Error,
			uuid: toolUuid,
			message: `Unknown MCP server: ${mcp.server}`,
		};
	}

	try {
		const response = await callMcpTool(server, mcp.toolName, call.args, {
			signal,
			timeoutMs: getMcpToolTimeoutMs(),
		});
		// A tool that asks for MORE input mid-call, on top of the approval it just
		// cleared, is a double-elicitation this resume path does not support: the
		// resume has no guard booking and no round left to re-park cleanly.
		if (response.inputRequired) {
			return {
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Error,
				uuid: toolUuid,
				message:
					"The tool asked for interactive input on top of the approval it was just granted, " +
					"which this call cannot wait on. Nothing further was submitted. Retry with complete arguments.",
			};
		}
		if (response.isError) {
			return {
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Error,
				uuid: toolUuid,
				message: response.text || "The tool reported an error with no message.",
			};
		}
		return {
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Result,
			uuid: toolUuid,
			result: {
				status: ToolResultStatus.Success,
				call: { name: mcp.toolName, parameters: {} },
				outputs: [
					{
						text: response.text ?? "",
						structured: response.structured,
						content: response.content,
					},
				] as unknown as Record<string, unknown>[],
				display: true,
			},
		};
	} catch (err) {
		logger.warn({ err, tool: mcp.toolName }, "[mcp] resumed approved call failed");
		return {
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Error,
			uuid: toolUuid,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Re-issue the tool call a durable prompt parked, now that it has an answer.
 *
 * The 2026-era server kept no state — `requestState` and the answers are the whole
 * continuation — so this runs anywhere, on any connection, however long afterwards.
 * Returns the update rather than writing it: the caller feeds it through the run's normal
 * update path, so it streams, persists, and lands in the writer's snapshot together —
 * writing it separately would be overwritten by the next materialise.
 */
export async function resumeParkedToolCall({
	conversationId,
	elicitationId,
	generationId,
	extraServers = [],
	signal,
}: {
	conversationId: ObjectId;
	elicitationId: string;
	generationId?: string;
	extraServers?: McpServerConfig[];
	signal?: AbortSignal;
}): Promise<{
	resumed: boolean;
	reason?: string;
	updates: MessageUpdate[];
	/** The tool asked something else; the run ends again until that is answered too. */
	parkedAgain?: boolean;
	/**
	 * Tools just granted "for the conversation" during this call. The caller's
	 * in-memory `conv` was read before this ran, so a turn that keeps going
	 * (another round, in the same `runMcpFlow` continuation) needs these
	 * folded into `conv.approvedTools` itself — the database write alone only
	 * helps the *next* fresh read of the conversation.
	 */
	grantedTools?: string[];
}> {
	const taken = await takeResumableElicitation(conversationId, elicitationId);
	const pending = taken?.row.pending;
	if (!taken || !pending) {
		return { resumed: false, reason: "no answered prompt to resume", updates: [] };
	}
	const { inputResponses } = taken;

	// Nothing emitted this while the run was over, so the transcript still shows an open
	// form. Settling it here is what lets a reloaded page render the answer instead.
	const settled: MessageUpdate = {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Resolved,
		elicitationId,
		action: taken.row.action ?? "cancel",
		resolution: "user",
		...(taken.row.content ? { content: taken.row.content } : {}),
	};

	// The model's own question: the answer is the result, so there is nothing to re-issue.
	if (pending.kind === "ask") {
		return {
			resumed: true,
			updates: [
				settled,
				{
					type: MessageUpdateType.Tool,
					subtype: MessageToolUpdateType.Result,
					uuid: pending.toolUuid,
					result: {
						status: ToolResultStatus.Success,
						call: { name: ASK_USER_QUESTION_TOOL_NAME, parameters: {} },
						outputs: [
							{
								text: answerToToolResult(
									taken.row.request,
									taken.row.action ?? "cancel",
									taken.row.content
								),
							},
						] as unknown as Record<string, unknown>[],
						display: true,
					},
				},
			],
		};
	}

	// The global tool-approval policy (ADR 0075), covering `web_fetch` and every
	// MCP tool: unlike the model's own question above, the answer here is not
	// the result — an accepted prompt re-issues the call itself, so approving
	// costs one click rather than a second model round trip. Several gated
	// calls from the same round queue behind this one rather than being
	// refused outright; each is drained here, one prompt at a time.
	if (pending.kind === "tool-approval") {
		const accepted = taken.row.action === "accept";
		const scope = taken.row.content?.[TOOL_APPROVAL_SCOPE_FIELD];
		const grantedTools: string[] = [];

		if (accepted && scope === TOOL_APPROVAL_CONVERSATION) {
			await collections.conversations.updateOne(
				{ _id: conversationId },
				{ $addToSet: { approvedTools: pending.tool } }
			);
			grantedTools.push(pending.tool);
		}

		const updates: MessageUpdate[] = [settled];
		updates.push(
			accepted
				? await runApprovedCall(pending, pending.toolUuid, extraServers, signal)
				: toolApprovalDenied(pending.toolUuid, pending.tool)
		);

		// Grants made just now: a later queue entry for the SAME tool must see
		// this click's grant without asking again, even though the database
		// write above is what makes it stick for calls after this turn.
		const grantedNow = new Set(grantedTools);

		let queue: PendingToolApprovalCall["queue"] = pending.queue;
		while (queue.length > 0) {
			const [next, ...rest] = queue;
			if (grantedNow.has(next.tool)) {
				updates.push(await runApprovedCall(next, next.toolUuid, extraServers, signal));
				queue = rest;
				continue;
			}

			const opened = await openToolApprovalPrompt({
				sink: {
					conversationId,
					...(generationId ? { generationId } : {}),
					emit: (u) => updates.push(u),
				},
				toolUuid: next.toolUuid,
				toolCallId: next.toolCallId,
				messageId: pending.messageId,
				tool: next.tool,
				args: next.args,
				...(next.mcp ? { mcp: next.mcp } : {}),
				queue: rest,
				userId: pending.userId,
				sessionId: pending.sessionId,
			});
			if (opened.opened) {
				return { resumed: true, updates, parkedAgain: true, grantedTools };
			}
			// Could not be shown: deny rather than lose the call silently, and
			// keep draining the rest of the queue instead of abandoning it.
			logger.warn(
				{ tool: next.tool, reason: opened.reason },
				"[tool-approval] could not open the next queued prompt"
			);
			updates.push(toolApprovalDenied(next.toolUuid, next.tool));
			queue = rest;
		}

		return { resumed: true, updates, grantedTools };
	}

	const server = [...getMcpServers(), ...extraServers].find((s) => s.name === pending.server);
	if (!server) return { resumed: false, reason: `unknown server ${pending.server}`, updates: [] };

	let update: MessageUpdate;
	try {
		const response = await callMcpTool(server, pending.tool, pending.args, {
			signal,
			timeoutMs: getMcpToolTimeoutMs(),
			resume: {
				inputResponses,
				...(pending.requestState !== undefined ? { requestState: pending.requestState } : {}),
			},
		});

		// A tool can ask more than once. Park again on the same call rather than handing
		// the model a round that never finished.
		if (response.inputRequired) {
			const collected: MessageUpdate[] = [];
			const opened = await openDurableElicitation({
				sink: {
					conversationId,
					...(generationId ? { generationId } : {}),
					emit: (u) => collected.push(u),
				},
				server: pending.server,
				toolUuid: pending.toolUuid,
				pending: {
					tool: pending.tool,
					args: pending.args,
					messageId: pending.messageId,
					toolCallId: pending.toolCallId,
					toolUuid: pending.toolUuid,
				},
				inputRequired: response.inputRequired,
			});
			if (opened.opened) {
				return { resumed: true, updates: [settled, ...collected], parkedAgain: true };
			}
			return {
				resumed: false,
				reason: `could not show the next prompt: ${opened.reason}`,
				updates: [settled],
			};
		}

		update = response.isError
			? {
					type: MessageUpdateType.Tool,
					subtype: MessageToolUpdateType.Error,
					uuid: pending.toolUuid,
					message: response.text || "The tool reported an error with no message.",
				}
			: {
					type: MessageUpdateType.Tool,
					subtype: MessageToolUpdateType.Result,
					uuid: pending.toolUuid,
					result: {
						status: ToolResultStatus.Success,
						call: { name: pending.tool, parameters: {} },
						outputs: [
							{
								text: response.text ?? "",
								structured: response.structured,
								content: response.content,
							},
						] as unknown as Record<string, unknown>[],
						display: true,
					},
				};
	} catch (err) {
		logger.warn({ err, tool: pending.tool }, "[mcp] resumed tool call failed");
		update = {
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Error,
			uuid: pending.toolUuid,
			message: err instanceof Error ? err.message : String(err),
		};
	}

	return { resumed: true, updates: [settled, update] };
}
