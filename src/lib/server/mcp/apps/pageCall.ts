import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { resolveToolApprovalPolicy } from "$lib/server/textGeneration/toolApprovalPolicy";
import type { Conversation } from "$lib/types/Conversation";
import type { Settings } from "$lib/types/Settings";
import { visibleToApp } from "$lib/utils/mcpApp";
import { callMcpTool, getMcpToolTimeoutMs } from "../httpClient";
import { getToolUiMeta } from "../tools";
import { McpAppError, resolveAppServer } from "./resource";
import { pageCallAllowed } from "./pageCallLimit";
import { approvalHash, consumeApproval, issueApproval } from "./pageApprovals";

/**
 * What the user chose on the approval card, sent by Cerea's own UI after the click, with the id the 409
 * issued for exactly this call. The id, not the word, is what the server trusts.
 */
export interface PageCallApproval {
	id: string;
	choice: "once" | "conversation" | "deny";
}

export interface PageCallInput {
	conversation: Pick<Conversation, "_id" | "toolApprovalOverride" | "approvedAppTools">;
	settings: Pick<Settings, "toolApprovalPolicy"> | null | undefined;
	userId?: ObjectId;
	/** The connector's key, from the card's stored snapshot; resolved again here, for this user. */
	connector: string;
	/** The MCP tool's own name. */
	tool: string;
	args: Record<string, unknown>;
	approval?: PageCallApproval;
	signal?: AbortSignal;
}

/** The result a page receives (an MCP `CallToolResult`). */
export interface PageCallResult {
	content: unknown[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

export type PageCallOutcome =
	| { ok: true; result: PageCallResult }
	| {
			ok: false;
			status: number;
			code:
				| "approval_required"
				| "approval_invalid"
				| "approval_busy"
				| "denied"
				| "rate_limited"
				| "not_allowed"
				| "unknown_connector"
				| "unknown_tool"
				| "needs_input"
				| "failed";
			message: string;
			/** For `approval_required`: what the card asks about. */
			approval?: { id: string; tool: string; server: string; toolName: string };
	  };

const MAX_ARGS_BYTES = 256 * 1024;

/**
 * A tool call started by an MCP App page, run on the server through the same gate as a model's call
 * (docs/dev/adr-mcp-apps.md, section 3): the connector is resolved for this user (never an address or a
 * credential from the browser), the tool must belong to it and be visible to apps, a call that needs
 * approval runs only with the user's click (sent by Cerea's own card, which a page cannot reach), and the
 * rate is limited. The call has no elicitation: there is no turn to park.
 */
export async function callToolFromPage(input: PageCallInput): Promise<PageCallOutcome> {
	const { conversation, settings, userId, connector, tool, args, approval, signal } = input;

	if (JSON.stringify(args).length > MAX_ARGS_BYTES) {
		return {
			ok: false,
			status: 413,
			code: "failed",
			message: "The call's arguments are too large.",
		};
	}

	let server;
	try {
		server = await resolveAppServer(connector, userId);
	} catch (err) {
		if (err instanceof McpAppError) {
			return {
				ok: false,
				status: err.code === "not-allowed" ? 403 : 404,
				code: err.code === "not-allowed" ? "not_allowed" : "unknown_connector",
				message: err.message,
			};
		}
		throw err;
	}

	const { listed, ui } = await getToolUiMeta(server, tool, { signal }).catch(() => ({
		listed: false,
		ui: undefined,
	}));
	if (!listed || !visibleToApp(ui)) {
		return {
			ok: false,
			status: 403,
			code: "unknown_tool",
			message: "That tool is not available to this page.",
		};
	}

	// The model's gate (ADR 0075), with the page's own grants: under `manual` a call runs only when the
	// conversation holds a grant for the page (never the model's grant: separate lists).
	const qualified = `${server.name}:${tool}`;
	const policy = resolveToolApprovalPolicy(conversation, settings);
	const granted = (conversation.approvedAppTools ?? []).includes(qualified);
	if (policy === "manual" && !granted) {
		const hash = approvalHash({ userId, connector, tool, args });
		if (!approval) {
			// The 409 path costs something too: asking is rate limited like calling.
			if (!pageCallAllowed(`${conversation._id.toString()}|${userId?.toString() ?? ""}|ask`)) {
				return {
					ok: false,
					status: 429,
					code: "rate_limited",
					message: "This page is asking too often. Try again in a moment.",
				};
			}
			const issued = await issueApproval(conversation._id, hash);
			if (!issued.ok) {
				return {
					ok: false,
					status: 429,
					code: "approval_busy",
					message: "Another call from a page is waiting for the user's answer.",
				};
			}
			return {
				ok: false,
				status: 409,
				code: "approval_required",
				message: "This call needs the user's approval.",
				approval: { id: issued.id, tool: qualified, server: server.name, toolName: tool },
			};
		}
		// Spent whatever the answer: a refusal frees the slot, an allow is one call.
		const spent = await consumeApproval(conversation._id, approval.id, hash);
		if (!spent) {
			return {
				ok: false,
				status: 403,
				code: "approval_invalid",
				message: "That approval is not valid for this call, or has expired.",
			};
		}
		if (approval.choice === "deny") {
			return { ok: false, status: 403, code: "denied", message: "The user denied this call." };
		}
		if (approval.choice === "conversation") {
			await collections.conversations.updateOne(
				{ _id: conversation._id },
				{ $addToSet: { approvedAppTools: qualified } }
			);
		}
	}

	if (!pageCallAllowed(`${conversation._id.toString()}|${userId?.toString() ?? ""}`)) {
		return {
			ok: false,
			status: 429,
			code: "rate_limited",
			message: "This page is making calls too fast. Try again in a moment.",
		};
	}

	logger.info(
		{ connector: server.name, tool, source: "app", granted, approval: approval?.choice ?? null },
		"[mcp-app] page-initiated tool call"
	);
	try {
		const raw = await callMcpTool(server, tool, args, {
			signal,
			timeoutMs: getMcpToolTimeoutMs(),
		});
		if (raw.inputRequired) {
			return {
				ok: false,
				status: 422,
				code: "needs_input",
				message: "The tool asked for interactive input, which a page's call cannot wait on.",
			};
		}
		const structured =
			typeof raw.structured === "object" &&
			raw.structured !== null &&
			!Array.isArray(raw.structured)
				? (raw.structured as Record<string, unknown>)
				: undefined;
		return {
			ok: true,
			result: {
				content:
					Array.isArray(raw.content) && raw.content.length > 0
						? raw.content
						: [{ type: "text", text: raw.text ?? "" }],
				...(structured ? { structuredContent: structured } : {}),
				...(raw.isError ? { isError: true } : {}),
			},
		};
	} catch (err) {
		logger.warn(
			{ connector: server.name, tool, err: err instanceof Error ? err.message : String(err) },
			"[mcp-app] page-initiated tool call failed"
		);
		return {
			ok: false,
			status: 502,
			code: "failed",
			message: err instanceof Error ? err.message : String(err),
		};
	}
}
