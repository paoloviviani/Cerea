import type { ObjectId } from "mongodb";
import type { MessageFile } from "$lib/types/Message";
import type { Backend, CredentialState, Policy } from "$lib/types/machineProtocol";
import {
	MessageUpdateType,
	type MessageElicitationRequestUpdate,
	type MessageElicitationResolvedUpdate,
	type MessagePlanUpdate,
	type MessageStreamUpdate,
	type MessageToolCallUpdate,
	type MessageToolErrorUpdate,
	type MessageToolResultUpdate,
	type MessageTurnStateUpdate,
} from "$lib/types/MessageUpdate";

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

/**
 * The agent SSE bridge carries the chat's own update shapes (`MessageUpdate`)
 * wherever a chat shape exists — stream tokens, tool call/result/error, plan,
 * elicitation request/resolution, turn state — so the transcript is folded by
 * the same machinery that renders a conversation. Two frames have no chat
 * counterpart and are agent-only:
 *
 * - `user`: the person's message, echoed back by the daemon. Chats author
 *   their user messages client-side, so chat's stream union has no such
 *   frame; an agent transcript is a replay of the daemon's log, and the log
 *   owns both sides.
 * - there is deliberately no diff frame: changed files live in the side
 *   pane, which fetches the daemon's checkout diff itself.
 *
 * Frames are plain JSON (no Dates), like everything else on this wire.
 */
export interface AgentUserMessageUpdate {
	type: "user";
	text: string;
	/** The machine's echo of `Message.clientMessageId` (spec): the id the
	 * person's attachments were uploaded under. */
	messageId?: string;
	/** Those attachments, as the store returns them (`findAttachments`),
	 * added by the bridge; the fold puts them on the user message. */
	files?: MessageFile[];
}

/**
 * The machine's process restarted mid-session (its `epoch` changed, spec
 * §7-§8): every seq before this point is gone, so the fold must discard the
 * whole transcript and rebuild from what follows — the frames right after a
 * `reset` are exactly the fresh epoch's own history. Travels the ordinary
 * `update` channel (never a separate SSE event type) so the client needs no
 * new plumbing beyond one more case in `consumeAgentUpdates`.
 */
export interface AgentResetUpdate {
	type: "reset";
}

/**
 * Context/usage, a side channel (M3): never touches the turn structure a
 * `user`/turn-state frame builds, folds independently of it, and re-converges
 * on the latest value rather than accumulating (a live `usage` event and the
 * snapshot's own `usage` both land here the same way). Field names are
 * Cerea's own, mapped from the machine's `Usage` shape in one place
 * (`machineTimeline.ts`) so an upstream rename there is a one-line fix.
 */
export interface AgentUsageUpdate {
	type: "usage";
	usage: {
		used?: number;
		max?: number;
		input?: number;
		output?: number;
		cacheRead?: number;
		reasoning?: number;
	};
}

/**
 * A compaction marker (M3), mapped from the machine's `compaction` part
 * (spec §7). `auto` distinguishes opencode's own context-overflow trigger
 * from a person's "Compact now" — undefined when the source is silent on it.
 */
export interface AgentCompactionUpdate {
	type: "compaction";
	auto?: boolean;
}

export type AgentStreamUpdate =
	| AgentUserMessageUpdate
	| AgentResetUpdate
	| AgentUsageUpdate
	| AgentCompactionUpdate
	| MessageStreamUpdate
	| MessageToolCallUpdate
	| MessageToolResultUpdate
	| MessageToolErrorUpdate
	| MessagePlanUpdate
	| MessageElicitationRequestUpdate
	| MessageElicitationResolvedUpdate
	| MessageTurnStateUpdate;

/** Frame `type` values the bridge may emit, for the client's backstop check. */
export const AGENT_STREAM_UPDATE_TYPES: readonly string[] = [
	"user",
	"reset",
	"usage",
	"compaction",
	MessageUpdateType.Stream,
	MessageUpdateType.Tool,
	MessageUpdateType.Plan,
	MessageUpdateType.Elicitation,
	MessageUpdateType.TurnState,
];

export type CodeTurnState = "idle" | "running" | "waiting-permission" | "done" | "error";

/**
 * One subagent a turn spawned (the provider's Task tool), as the daemon's
 * roster reports it — the polled list is the authority for its title, status
 * and subtitle. `toolCallId` is the parent transcript's Task tool call, and
 * is what anchors the subagent's card there; a subagent spawned without a
 * tool call carries `null` and has no anchor, so the panel does not render
 * it rather than guessing a position.
 *
 * Plain JSON only (no Dates): it crosses the forwarder's superjson wire as
 * the daemon reported it.
 */
export interface CodeSubagent {
	id: string;
	parentAgentId: string;
	parentSubagentId?: string | null;
	provider: string;
	title: string | null;
	description: string | null;
	status: CodeSubagentStatus;
	createdAt: string;
	updatedAt: string;
	toolCallId: string | null;
	cwd?: string | null;
	subtitle?: string | null;
}

export type CodeSubagentStatus = "running" | "completed" | "failed" | "canceled";

/**
 * What the transcript's subagent card renders from, at the Task tool call it
 * anchors. Built by the view (`AgentView`) when it merges the polled roster
 * with the transcript's task calls; the card and `ChatMessage` see only this.
 *
 * `subagent` is null while the call is still running and the poll has not
 * named it yet — the anchor is then the call itself (opencode names the spawn
 * tool `task`), the title falls back to the call's own description, and the
 * status reads running. Once the poll has paired a descriptor, it rules.
 */
export interface CodeSubagentAnchor {
	subagent: CodeSubagent | null;
	/** The task call's own description, the title until the roster names it. */
	fallbackTitle: string;
	/**
	 * Fetch the subagent's own transcript, as agent frames for the chat's
	 * fold. Null while `subagent` is — without an id there is nothing to
	 * fetch, so the card offers no expansion yet.
	 */
	load: (() => Promise<AgentStreamUpdate[]>) | null;
}

/**
 * One of the daemon's provider modes — paseo's own permission vocabulary
 * (plan, build, …), listed live so the panel never hardcodes a set that
 * would drift from what the daemon enforces. `AgentMode` in the protocol.
 */
export interface CodeProviderMode {
	id: string;
	label: string;
	description?: string;
}

/** One of the daemon's provider models (`AgentModelDefinition`, trimmed). */
export interface CodeProviderModel {
	id: string;
	label: string;
	description?: string;
	isDefault?: boolean;
}

export interface CodeFileChange {
	path: string;
	/** Unified presentation: the before and after the diff viewer aligns. */
	oldText: string;
	newText: string;
}

/**
 * A paired machine: somebody's own box, running `pystino-agent`, dialled in
 * over the machine link (`reports/2026-09-24-thin-agent-protocol.md`).
 *
 * Nothing capability-bearing lives here — the row names a machine and records
 * what it last reported about itself; the only thing that can actually reach
 * it is a live socket in the in-process registry (`$lib/server/code/machines.ts`),
 * which a Mongo dump cannot hold. Revoking is real: the socket is closed
 * (4403) and a `machineId` marked `revoked` is refused at the next connect,
 * unlike the old daemon capability tuple this replaces.
 */
export type CodeDeviceStatus = "pending" | "paired" | "revoked";

export interface CodeDevice {
	_id: ObjectId;
	userId: ObjectId;
	/** The machine's own generated id (`X-Pystino-Machine-Id`); stable across
	 * reconnects, but a fresh one for every re-enroll. Unique per user. */
	machineId: string;
	name: string;
	status: CodeDeviceStatus;
	/** The OIDC subject the machine's bearer carried when it first connected
	 * (or last reconnected) — recorded for audit, never used for ownership:
	 * ownership is `userId`, decided once at connect time by `machineAuth.ts`. */
	sub: string;
	/** The issuer that minted the bearer, trailing-slash normalized. */
	iss: string;
	/** The backends `hello` reported (opencode, later others). */
	backends: Backend[];
	/** The machine's own policy (`hello`), shown so the UI can explain a
	 * refusal — the panel cannot override it; it is the machine's veto. */
	policy: Policy;
	/** The gateway/enrollment credential's last reported health. */
	credentialState: CredentialState;
	lastSeenAt?: Date;
	createdAt: Date;
	updatedAt: Date;
	pairedAt?: Date;
}

/** A working directory the daemon serves agents from. Lives on the daemon. */
export interface CodeWorkspace {
	id: string;
	name: string;
	path: string;
	isGitRepo: boolean;
	/** Set when this workspace is a `git worktree` of another workspace. */
	worktreeOf?: string;
	branch?: string;
}

/** One `workspace.suggest` result: a directory autocomplete candidate for
 * the "Add workspace" dialog's path input. */
export interface CodeDirectory {
	path: string;
	name: string;
	isGitRepo: boolean;
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
	/**
	 * The daemon's live session config, as the snapshot reports it: the mode
	 * is paseo's permission vocabulary (plan, build, …) switched by the
	 * composer's pill, and the model the provider runs. Both are `null`
	 * until the daemon has reported them — an agent that never answered
	 * shows pills that carry no claim.
	 */
	modeId: string | null;
	modelId: string | null;
}
