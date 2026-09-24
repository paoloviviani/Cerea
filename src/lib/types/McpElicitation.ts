import type { ObjectId } from "mongodb";
import type { Conversation } from "./Conversation";
import type { Timestamps } from "./Timestamps";

export const MAX_OTHER_CHARS = 200;

/** Normalized from MCP's `PrimitiveSchemaDefinition`, which spells a select box six ways. */
export type ElicitationField =
	| {
			kind: "string";
			name: string;
			title?: string;
			description?: string;
			required: boolean;
			minLength?: number;
			maxLength?: number;
			format?: "email" | "uri" | "date" | "date-time";
			default?: string;
	  }
	| {
			kind: "number";
			name: string;
			title?: string;
			description?: string;
			required: boolean;
			integer: boolean;
			minimum?: number;
			maximum?: number;
			default?: number;
	  }
	| {
			kind: "boolean";
			name: string;
			title?: string;
			description?: string;
			required: boolean;
			default?: boolean;
	  }
	| {
			kind: "select";
			name: string;
			title?: string;
			description?: string;
			required: boolean;
			multiple: boolean;
			options: Array<{
				value: string;
				label: string;
				description?: string;
				/**
				 * ML Assistant sessions only: choosing this option sets the session
				 * compute budget to this many dollars. Applied by trusted server code
				 * when the user submits the answer — never by the model — and always
				 * rendered next to the option so the label cannot hide the amount.
				 */
				setBudgetUsd?: number;
			}>;
			/** Offers an "Other" choice whose value is typed rather than picked. */
			allowOther?: boolean;
			minItems?: number;
			maxItems?: number;
			default?: string | string[];
	  };

export type ElicitationValue = string | number | boolean | string[];

export type ElicitationAction = "accept" | "decline" | "cancel";

/** `withdrawn` is the server giving up on its own request, which it usually does first. */
export type ElicitationResolution = "user" | "expired" | "aborted" | "withdrawn";

/** Every string here is server-authored, so it is display text and never markup. */
export interface ElicitationRequestPayload {
	elicitationId: string;
	/**
	 * Who is asking. `assistant` is the model's own question, which pins to the composer
	 * rather than sitting in the stream; absent means an MCP server asked.
	 */
	source?: "assistant";
	server: string;
	mode: "form" | "url";
	message: string;
	fields?: ElicitationField[];
	url?: string;
	/**
	 * Present only for a tool-approval prompt (ADR 0075): the dedicated
	 * three-button card renders this instead of the generic form, naming the
	 * tool and unfolding its exact arguments. `mode` stays `"form"` so the
	 * ordinary scope field (once / for the conversation) still validates and
	 * persists through the existing elicitation-answer machinery.
	 */
	toolApproval?: { tool: string; args: Record<string, unknown> };
	/**
	 * Set when the asker is a subagent rather than the watched session
	 * itself: the child session id the reply must be forwarded to (the
	 * elicitation id alone is only unique per session), and the child's
	 * title for the card's "Subagent ‹title›" label. Absent for the
	 * session's own asks — the reply then targets the watched session.
	 */
	childSessionId?: string;
	childTitle?: string | null;
}

/** In the database because the pod serving the answer need not be the one waiting on it. */
export interface McpElicitation extends Timestamps {
	_id: ObjectId;
	elicitationId: string;
	conversationId: Conversation["_id"];
	generationId?: string;
	status: "pending" | "resolved";
	request: ElicitationRequestPayload;
	action?: ElicitationAction;
	content?: Record<string, ElicitationValue>;
	/** Absent for a 2026-era prompt: nothing is waiting, so nothing expires. */
	expiresAt?: Date;
	resolvedAt?: Date;
	pending?: PendingCall;
}

/** Where the parked run picks up. `kind` is absent on rows written before ask existed. */
export type PendingCall = PendingMcpCall | PendingAskCall | PendingToolApprovalCall;

interface PendingCallBase {
	messageId: string;
	toolCallId: string;
	toolUuid: string;
}

/**
 * Re-issues the call against the server. Only a 2026-era prompt parks like this: the
 * server kept no state, so any process can continue it however long afterwards.
 */
export interface PendingMcpCall extends PendingCallBase {
	kind?: "mcp";
	server: string;
	tool: string;
	args: Record<string, unknown>;
	/** Opaque; echoed back byte-exact. */
	requestState?: string;
	/** Which key in the server's `inputRequests` this form answers. */
	inputKey: string;
}

/** Nothing to re-issue: the answer itself is the tool result. */
export interface PendingAskCall extends PendingCallBase {
	kind: "ask";
}

/**
 * A call gated by the global tool-approval policy (ADR 0075:
 * `Settings.toolApprovalPolicy === "manual"`), covering `web_fetch` and every
 * MCP tool. Unlike `PendingAskCall`, the answer is not the result: an
 * accepted prompt re-issues the call itself (see `resumeElicitation.ts`),
 * because a click should not cost the model a second round trip.
 */
export interface PendingToolApprovalCall extends PendingCallBase {
	kind: "tool-approval";
	/** Grant key: server-qualified (`"server:tool"`) for MCP, else the builtin name (`"web_fetch"`). */
	tool: string;
	/** Unfolded call arguments, shown on the approval card and replayed on accept. */
	args: Record<string, unknown>;
	/** Present for an MCP call; absent for the `web_fetch` builtin. */
	mcp?: { server: string; toolName: string };
	/**
	 * Other gated calls queued behind this one in the same round (ADR 0075:
	 * "several calls are approved one at a time" rather than the second
	 * being refused outright). Popped one at a time as each prompt resolves.
	 */
	queue: QueuedApprovalCall[];
	/** Who the turn belongs to, so the deny-timeout sweep can resume with no request to read an identity from. */
	userId?: ObjectId;
	sessionId?: string;
}

/** One call waiting behind the currently-shown tool-approval prompt. */
export interface QueuedApprovalCall {
	toolUuid: string;
	toolCallId: string;
	tool: string;
	args: Record<string, unknown>;
	mcp?: { server: string; toolName: string };
}
