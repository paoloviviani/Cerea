import type { ObjectId } from "mongodb";
import type { Message } from "./Message";
import type { PlanState } from "./Plan";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";
import type { Project } from "./Project";

export interface Conversation extends Timestamps {
	_id: ObjectId;

	sessionId?: string;
	userId?: User["_id"];

	model: string;

	/**
	 * The connectors whose tools the assistant has loaded in this conversation
	 * (`load_tools`, ADR 0104), as connector keys, in the order they were
	 * loaded. They stay loaded on later turns, and a later load is appended, so
	 * the start of the request stays the same and prompt caching keeps working.
	 * (`mcpSelection`, the per-chat selection this replaced, is no longer read.)
	 */
	loadedConnectors?: string[];

	title: string;
	rootMessageId?: Message["id"];
	messages: Message[];

	preprompt?: string;

	/**
	 * The project this conversation belongs to, if any. Set at creation, and
	 * changed by an explicit move (`moveConversationToProject`). A project
	 * supplies the standing context every turn is generated against, read from
	 * this field at each turn; a move therefore applies from the next message
	 * on and rewrites nothing in the history.
	 */
	projectId?: Project["_id"];

	/**
	 * Message ids already written into the project's memory base, so a
	 * conversation revisited or branched does not index the same exchange
	 * twice. Only written when the project has `indexPastChats` on.
	 */
	indexedMessageIds?: string[];

	/**
	 * Knowledge bases attached to this conversation by hand, from the
	 * composer's upload menu. Used in addition to any bases the conversation's
	 * project carries, never instead of them, and validated at attach time
	 * against the attacher's own access — every later turn re-checks the
	 * reader's reach at retrieval, so a share revoked after attaching simply
	 * stops contributing passages.
	 */
	knowledgeBaseIds?: string[];

	userAgent?: string;

	/**
	 * Set when a scheduled run answered in this conversation (`schedules/
	 * chatScheduleExecutor.ts`) and cleared when its owner opens it: the
	 * sidebar's unread dot.
	 */
	scheduledUnread?: true;

	/** The user's web-search consent for this conversation (ADR 0058's plan). */
	webSearch?: boolean;

	/**
	 * Tools the user has approved for the rest of this conversation, under
	 * the global `manual` tool-approval policy (ADR 0075): tool names,
	 * server-qualified for MCP calls. Written only from a resolved approval
	 * prompt ("accept for the conversation"), never by the model. Dies with
	 * the conversation; there is no cross-chat grant.
	 */
	approvedTools?: string[];

	/**
	 * Chat-local override of `Settings.toolApprovalPolicy` (ADR 0075). Absent
	 * means this chat follows the user's setting. Set by the composer's
	 * toggle, in either direction — turning always-allow on for one chat
	 * under a `manual` default, or back to manual for one chat under an
	 * always-allow default. Settings hold the default; this is per-chat state.
	 */
	toolApprovalOverride?: "always-allow" | "manual";
	/** Thinking effort chosen for this conversation; unset means the user's
	 * per-model default (`settings.reasoningEffortOverrides`), then the model's. */
	reasoningEffort?: "low" | "medium" | "high";

	/**
	 * Written by the `update_plan` builtin tool with its own targeted `$set`, so
	 * the messages-only writes in the conversation route never clobber it.
	 */
	plan?: PlanState;
}
