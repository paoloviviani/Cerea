/**
 * The chat drives coding-agent sessions (ADR 0106): the shared shapes of the
 * session card a conversation keeps, and of a user's agent profile for a
 * project. Server (the `agent_*` builtins, the profile API) and client (the
 * card, the project settings section) both build on these.
 */
import type { PermissionMode } from "$lib/types/machineProtocol";

/** Names shown with no live machine ("machine › workspace"). */
export interface AgentSessionLabels {
	device: string;
	workspace: string;
}

/**
 * Emitted by `agent_start` ("started") and `agent_send` ("prompted"), stored
 * with the message so the card survives a reload. Ids are the caller's own
 * device and session; the card reads the live state from the /code data.
 */
export interface AgentSessionCard {
	action: "started" | "prompted";
	deviceId: string;
	workspaceId: string;
	sessionId: string;
	title: string;
	labels: AgentSessionLabels;
}

/**
 * A user's own default target for agent sessions started from a project's
 * chats. Per (project, user): projects can be shared, a machine is one
 * user's. Stored in `projectAgentProfiles`; served by
 * `GET | PUT | DELETE /api/v2/projects/[id]/agent-profile`.
 */
export interface ProjectAgentProfile {
	deviceId: string;
	workspaceId: string;
	/** Applied to sessions `agent_start` creates; `ask` when there is no profile. */
	permissionMode: PermissionMode;
	modeId?: string;
	modelId?: string;
	/** Connectors sessions started from this project's chats may use (ADR 0108); none by default. */
	connectorKeys?: string[];
	labels: AgentSessionLabels;
	updatedAt: string;
}

/** The body of `PUT /api/v2/projects/[id]/agent-profile` (labels are resolved by the server). */
export type ProjectAgentProfileInput = Pick<
	ProjectAgentProfile,
	"deviceId" | "workspaceId" | "permissionMode" | "modeId" | "modelId" | "connectorKeys"
>;
