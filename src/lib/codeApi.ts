/**
 * Talking to the coding-agent panel from a page, through this app's own endpoints.
 *
 * Every call goes to `/api/v2/code/<path>`. Pairing rows are brokered by Cerea
 * itself (per-user Mongo records); live agent state is proxied to the paseo
 * daemon with the deployment's credential attached server-side. Either way
 * the browser holds no secret — putting one on the page would make every
 * extension a daemon client.
 *
 * Responses from these endpoints use the superjson wire format (Dates stay
 * Dates); errors carry the server's own message, written for whoever caused
 * them, and are not replaced with a generic "request failed".
 */

import superjson from "superjson";
import { base } from "$app/paths";
import type { CodeDeviceView } from "$lib/server/codeDevices";
import type {
	CodeAgentSession,
	CodeFileChange,
	CodeProviderMode,
	CodeProviderModel,
	CodeWorkspace,
} from "$lib/types/CodeAgent";

export type { CodeDeviceView };

/** One provider feature the panel can toggle on an agent — the daemon's
 * `AgentFeatureToggle`, trimmed. Select features (a value chosen from a
 * list) are dropped at the forwarder: the panel offers switches, not menus. */
export interface CodeProviderFeature {
	id: string;
	label: string;
	description?: string;
	value: boolean;
}

export class CodeApiError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = "CodeApiError";
	}
}

async function unwrap<T>(response: Response): Promise<T> {
	const text = await response.text();
	if (!response.ok) {
		let message = text || `The request failed with status ${response.status}.`;
		try {
			const parsed = JSON.parse(text) as { message?: string; error?: { message?: string } };
			message = parsed.message ?? parsed.error?.message ?? message;
		} catch {
			/* not JSON — the raw text is the best available */
		}
		throw new CodeApiError(message, response.status);
	}
	return (text ? superjson.parse<T>(text) : null) as T;
}

const root = () => `${base}/api/v2/code`;

export async function listDevices(): Promise<{ devices: CodeDeviceView[] }> {
	return unwrap(await fetch(`${root()}/devices`));
}

export async function startPairing(name: string): Promise<{ device: CodeDeviceView }> {
	return unwrap(
		await fetch(`${root()}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "start", name }),
		})
	);
}

export async function claimPairing(
	code: string,
	offer: string
): Promise<{ device: CodeDeviceView }> {
	return unwrap(
		await fetch(`${root()}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "claim", code, offer }),
		})
	);
}

export async function revokeDevice(id: string): Promise<{ revoked: boolean }> {
	return unwrap(
		await fetch(`${root()}/devices?id=${encodeURIComponent(id)}`, { method: "DELETE" })
	);
}

// -- live daemon state, through the relay, per paired device -----------------
//
// Every call names its device (`?device=`); the server checks the row
// belongs to the caller, then reaches that machine through the relay. These
// 404 when the device is unknown, and 502 when the daemon behind it cannot
// be reached. Callers treat both as "the daemon is not connected" rather
// than a failure: the panel reads cleanly on a flag-on/daemon-off
// deployment.

/** Working directories the daemon serves agents from. */
export async function listWorkspaces(deviceId: string): Promise<{ workspaces: CodeWorkspace[] }> {
	return unwrap(await fetch(`${root()}/v1/workspaces?device=${encodeURIComponent(deviceId)}`));
}

/** A workspace backed by an existing directory on the daemon's machine. */
export async function createWorkspace(
	deviceId: string,
	input: { path: string; title?: string }
): Promise<{ workspace: CodeWorkspace }> {
	return unwrap(
		await fetch(`${root()}/v1/workspaces?device=${encodeURIComponent(deviceId)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		})
	);
}

/** Every session on the device, across its workspaces — the daemon groups
 * them by `workspaceId`, which is what the tree needs in one call. */
export async function listAgents(deviceId: string): Promise<{ agents: CodeAgentSession[] }> {
	return unwrap(await fetch(`${root()}/v1/agents?device=${encodeURIComponent(deviceId)}`));
}

/** Coding sessions in one workspace. Live on the daemon; never cached here. */
export async function listWorkspaceAgents(
	deviceId: string,
	workspaceId: string
): Promise<{ agents: CodeAgentSession[] }> {
	return unwrap(
		await fetch(
			`${root()}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents?device=${encodeURIComponent(deviceId)}`
		)
	);
}

/** The provider ids this daemon can actually run, from the daemon itself. */
export async function listProviders(
	deviceId: string
): Promise<{ providers: Array<{ id: string; available: boolean }> }> {
	return unwrap(await fetch(`${root()}/v1/providers?device=${encodeURIComponent(deviceId)}`));
}

/** The provider's modes — paseo's permission vocabulary (plan, build, …),
 * as the daemon itself defines it. */
export async function listProviderModes(
	deviceId: string,
	provider: string
): Promise<{ modes: CodeProviderMode[] }> {
	return unwrap(
		await fetch(
			`${root()}/v1/providers/${encodeURIComponent(provider)}/modes?device=${encodeURIComponent(deviceId)}`
		)
	);
}

/** The provider's models, as the daemon reports them (selectable only). */
export async function listProviderModels(
	deviceId: string,
	provider: string
): Promise<{ models: CodeProviderModel[] }> {
	return unwrap(
		await fetch(
			`${root()}/v1/providers/${encodeURIComponent(provider)}/models?device=${encodeURIComponent(deviceId)}`
		)
	);
}

/** The provider's features — the toggles a person can flip on an agent
 * (opencode's auto-accept) — as the daemon drafts them for a config like
 * the agent's. The query needs the agent's working directory; the agent's
 * mode and model ride along when known. This list says what EXISTS and
 * what it is called; the live value is the agent snapshot's word
 * (`getAgent`), never this list's. */
export async function listProviderFeatures(
	deviceId: string,
	provider: string,
	draft: { cwd: string; modeId?: string; model?: string }
): Promise<{ features: CodeProviderFeature[] }> {
	const params = new URLSearchParams({
		device: deviceId,
		cwd: draft.cwd,
		...(draft.modeId ? { modeId: draft.modeId } : {}),
		...(draft.model ? { model: draft.model } : {}),
	});
	return unwrap(
		await fetch(
			`${root()}/v1/providers/${encodeURIComponent(provider)}/features?${params.toString()}`
		)
	);
}

/** A new coding session on the daemon, scoped to one of its workspaces. */
export async function createAgent(
	deviceId: string,
	input: {
		cwd: string;
		provider?: string;
		posture?: AgentPosture;
		title?: string;
		workspaceId?: string;
	}
): Promise<{ agent: CodeAgentSession }> {
	return unwrap(
		await fetch(`${root()}/v1/agents?device=${encodeURIComponent(deviceId)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		})
	);
}

/** One agent's current record (title, provider, state), with the two
 * things the open screen needs beside it: the provider features the agent
 * ITSELF reports — the auto-accept toggle's live value lives here, not in
 * the provider's feature list — and the cwd the feature query requires. */
export async function getAgent(
	deviceId: string,
	agentId: string
): Promise<{ agent: CodeAgentSession; features: CodeProviderFeature[]; cwd: string }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}?device=${encodeURIComponent(deviceId)}`
		)
	);
}

/** The files one agent has changed, as before/after pairs for the diff viewer. */
export async function getAgentDiff(
	deviceId: string,
	agentId: string
): Promise<{ files: CodeFileChange[] }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/diff?device=${encodeURIComponent(deviceId)}`
		)
	);
}

// -- control: follow-ups and approvals (Phase 3) ----------------------------

/** How much licence a new agent starts with. Creation-time only: the live
 * switch is the mode pill on the open agent (ADR 0085's panel drives the
 * daemon's own mode vocabulary). */
export type AgentPosture = "plan" | "write";

export type PermissionDecision = "approve" | "deny";

/** Send a follow-up to a running session. The reply arrives on the timeline
 * stream. No licence rides along: the agent's mode — paseo's permission
 * vocabulary — is switched live by the composer's mode pill and stays until
 * switched again, which is paseo's own semantics rather than a per-send
 * override. */
export async function sendFollowUp(
	deviceId: string,
	agentId: string,
	text: string
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/messages?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text }),
			}
		)
	);
}

/** Switch the open agent's mode. A provider refusal comes back as the
 * notice text (null when applied without comment). */
export async function setAgentMode(
	deviceId: string,
	agentId: string,
	modeId: string
): Promise<{ ok: boolean; notice: string | null }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/mode?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ modeId }),
			}
		)
	);
}

/** Switch the open agent's model (`null` resets to the provider's default). */
export async function setAgentModel(
	deviceId: string,
	agentId: string,
	modelId: string | null
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/model?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ modelId }),
			}
		)
	);
}

/** Flip one of the agent's provider features — the auto-accept toggle and
 * its kind. The answer is only the POST's receipt: the toggle's label
 * claims the new value when the refreshed agent snapshot agrees, never
 * from this call. */
export async function setAgentFeature(
	deviceId: string,
	agentId: string,
	featureId: string,
	value: boolean
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/feature?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ featureId, value }),
			}
		)
	);
}

/** Stop the agent's live turn — the way out of a runaway run and of a
 * permission prompt nobody wants to answer. The answer is the POST's
 * receipt, nothing more: the turn's end (`turn_canceled`) and the denied
 * resolutions of any outstanding permission requests arrive on the
 * transcript stream, which is the source of truth. */
export async function cancelAgent(deviceId: string, agentId: string): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/cancel?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}
		)
	);
}

/** Answer a waiting permission request. Blocking: the agent holds until this lands. */
export async function respondPermission(
	deviceId: string,
	agentId: string,
	requestId: string,
	decision: PermissionDecision
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/permissions/${encodeURIComponent(requestId)}?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ decision }),
			}
		)
	);
}

// -- archival: leaving the daemon's active lists ------------------------------
//
// Both removals are the daemon's own archive operations, named by the path
// alone (no body). An archived session disappears from every daemon listing
// — which is where the tree reads from — with its transcript archived on the
// daemon, and nothing on the person's disk changes; a deleted workspace goes
// the same way and takes its sessions with it. Callers confirm first and
// redraw the tree from the daemon afterwards.

/** Archive one session. The row leaves the tree when the daemon is re-read. */
export async function archiveAgent(deviceId: string, agentId: string): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/archive?device=${encodeURIComponent(deviceId)}`,
			{ method: "POST" }
		)
	);
}

/** Delete (archive) a workspace: its sessions go with it, local files stay. */
export async function archiveWorkspace(
	deviceId: string,
	workspaceId: string
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/workspaces/${encodeURIComponent(workspaceId)}/archive?device=${encodeURIComponent(deviceId)}`,
			{ method: "POST" }
		)
	);
}

/** Rename a workspace: the daemon's setWorkspaceTitle, answering the title
 * as the daemon recorded it (`null` clears the custom name). */
export async function renameWorkspace(
	deviceId: string,
	workspaceId: string,
	title: string | null
): Promise<{ title: string | null }> {
	return unwrap(
		await fetch(
			`${root()}/v1/workspaces/${encodeURIComponent(workspaceId)}/title?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title }),
			}
		)
	);
}

/** Rename an agent: the daemon's updateAgent name. */
export async function renameAgent(
	deviceId: string,
	agentId: string,
	name: string
): Promise<{ ok: true }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/name?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name }),
			}
		)
	);
}
