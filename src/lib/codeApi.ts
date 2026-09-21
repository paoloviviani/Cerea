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
import type { CodeAgentSession, CodeFileChange, CodeWorkspace } from "$lib/types/CodeAgent";

export type { CodeDeviceView };

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

/** One agent's current record (title, provider, state). */
export async function getAgent(
	deviceId: string,
	agentId: string
): Promise<{ agent: CodeAgentSession }> {
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

/** How much licence a follow-up carries. Sent with every message; the daemon enforces it. */
export type AgentPosture = "plan" | "write";

export interface FollowUpOptions {
	/** Which runner answers. opencode-first; the daemon may run others later. */
	provider?: string;
	/** Defaults to "plan": propose, never write, until the person opts into writes. */
	posture?: AgentPosture;
}

/** Send a follow-up to a running session. The reply arrives on the timeline stream. */
export async function sendFollowUp(
	deviceId: string,
	agentId: string,
	text: string,
	options: FollowUpOptions = {}
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/messages?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text,
					provider: options.provider || "opencode",
					posture: options.posture ?? "plan",
				}),
			}
		)
	);
}

export type PermissionDecision = "approve" | "deny";

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
