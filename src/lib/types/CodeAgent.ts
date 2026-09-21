import type { ObjectId } from "mongodb";

/**
 * The `/code` surface: a remote-control panel for coding agents, NOT a chat
 * mode.
 *
 * A mode in this app is a boolean latched on a `Conversation` document
 * (`Conversation.mlAssistant`) — inherently conversation-bound. This surface
 * has no conversation; it is a top-level route that drives a self-hosted
 * "paseo" daemon (which runs `opencode` agents on the person's own machine)
 * through the Cerea server. The browser never talks to the daemon directly.
 *
 * Persistence split, by design: the daemon owns sessions and worktrees; Cerea
 * persists only pairing/device records (Mongo, `codeDevices`) and proxies
 * live agent state. Live state is a rendering concern, never mirrored into
 * Mongo — there is deliberately no second agent store.
 *
 * The update union below follows the discriminated-union style of
 * `MessageUpdate` (`$lib/types/MessageUpdate.ts`) but is agent-specific and
 * does NOT overload chat's union: these frames travel the agent SSE bridge
 * (`api/v2/code/agents/[id]/stream`), never the chat JSONL stream.
 */

export enum CodeAgentUpdateType {
	AgentMessage = "agent-message",
	ToolCall = "tool-call",
	Plan = "plan",
	TurnState = "turn-state",
	PermissionRequest = "permission-request",
	Diff = "diff",
}

export type CodeAgentUpdate =
	| CodeAgentMessageUpdate
	| CodeToolCallUpdate
	| CodePlanUpdate
	| CodeTurnStateUpdate
	| CodePermissionRequestUpdate
	| CodeDiffUpdate;

export interface CodeAgentMessageUpdate {
	type: CodeAgentUpdateType.AgentMessage;
	/** Which party spoke: the agent's prose, or the person's follow-up echoed back. */
	role: "agent" | "user";
	text: string;
	/** Present while the agent is still streaming this message. */
	partial?: boolean;
}

export type CodeToolCallStatus = "running" | "done" | "error";

export interface CodeToolCallUpdate {
	type: CodeAgentUpdateType.ToolCall;
	/** Daemon-issued call id; result frames carry the same id. */
	id: string;
	tool: string;
	input?: Record<string, unknown>;
	output?: string;
	status: CodeToolCallStatus;
}

export interface CodePlanStep {
	title: string;
	status: "pending" | "active" | "done";
}

export interface CodePlanUpdate {
	type: CodeAgentUpdateType.Plan;
	goal: string;
	steps: CodePlanStep[];
}

export type CodeTurnState = "idle" | "running" | "waiting-permission" | "done" | "error";

export interface CodeTurnStateUpdate {
	type: CodeAgentUpdateType.TurnState;
	state: CodeTurnState;
	detail?: string;
}

export interface CodePermissionRequestUpdate {
	type: CodeAgentUpdateType.PermissionRequest;
	/** Answered against `v1/agents/{id}/permissions/{requestId}`. */
	requestId: string;
	/** What the agent wants to do, in its own words. */
	description: string;
	/** The command or operation awaiting approval, when there is one. */
	command?: string;
	/** True while the daemon still waits; false once answered (replay). */
	pending: boolean;
	/** How it was answered, once it was. */
	resolution?: "approved" | "denied";
}

export interface CodeFileChange {
	path: string;
	/** Unified presentation: the before and after the diff viewer aligns. */
	oldText: string;
	newText: string;
}

export interface CodeDiffUpdate {
	type: CodeAgentUpdateType.Diff;
	files: CodeFileChange[];
}

/** A paired device: somebody's machine running the paseo daemon. */
export type CodeDeviceStatus = "pending" | "paired";

export interface CodeDevice {
	_id: ObjectId;
	userId?: ObjectId;
	sessionId?: string;
	name: string;
	status: CodeDeviceStatus;
	/**
	 * The short code shown at pairing time. The person runs `paseo daemon
	 * pair` on their machine and pastes the pairing link it prints back into
	 * the panel; the code alone proves the person saw this row, and the pasted
	 * offer carries the daemon's relay identity. Cleared once paired — it is
	 * single-use by design.
	 */
	pairingCode?: string;
	/** Daemon-reported device id, recorded when the pairing completes. */
	daemonId?: string;
	/**
	 * The daemon's Curve25519 public key, from the pairing offer the person
	 * pasted at claim time. This is half of the E2EE channel key material:
	 * the offer as a whole is the bearer capability for the daemon (paseo
	 * treats its QR code like a password), so it is stored with the same
	 * care as a credential and never leaves the server.
	 */
	daemonPublicKey?: string;
	/**
	 * When an unclaimed pairing stops existing. Set only while `pending` —
	 * a paired row carries no expiry, so the TTL index below can never
	 * delete a live device. Cleared by `claim` alongside `pairingCode`.
	 */
	expiresAt?: Date;
	createdAt: Date;
	updatedAt: Date;
	pairedAt?: Date;
}

/** A working directory the daemon serves agents from. Lives on the daemon. */
export interface CodeWorkspace {
	id: string;
	name: string;
	path: string;
}

/** A coding session on a device. Lives on the daemon; never mirrored here. */
export interface CodeAgentSession {
	id: string;
	workspaceId: string;
	title: string;
	/** opencode-first; the daemon may run others later, so this stays a string. */
	provider: string;
	state: CodeTurnState;
	updatedAt: string;
}
