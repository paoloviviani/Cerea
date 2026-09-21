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

export async function claimPairing(code: string): Promise<{ device: CodeDeviceView }> {
	return unwrap(
		await fetch(`${root()}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "claim", code }),
		})
	);
}

export async function revokeDevice(id: string): Promise<{ revoked: boolean }> {
	return unwrap(
		await fetch(`${root()}/devices?id=${encodeURIComponent(id)}`, { method: "DELETE" })
	);
}

// -- live daemon state, through the allowlisted forwarder --------------------
//
// These 404 when the path is not offered and 502 when no daemon is behind
// them. Callers treat both as "the daemon is not connected" rather than a
// failure: the panel reads cleanly on a flag-on/daemon-off deployment.

/** Working directories the daemon serves agents from. */
export async function listWorkspaces(): Promise<{ workspaces: CodeWorkspace[] }> {
	return unwrap(await fetch(`${root()}/v1/workspaces`));
}

/** Coding sessions in one workspace. Live on the daemon; never cached here. */
export async function listWorkspaceAgents(
	workspaceId: string
): Promise<{ agents: CodeAgentSession[] }> {
	return unwrap(await fetch(`${root()}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`));
}

/** One agent's current record (title, provider, state). */
export async function getAgent(agentId: string): Promise<{ agent: CodeAgentSession }> {
	return unwrap(await fetch(`${root()}/v1/agents/${encodeURIComponent(agentId)}`));
}

/** The files one agent has changed, as before/after pairs for the diff viewer. */
export async function getAgentDiff(agentId: string): Promise<{ files: CodeFileChange[] }> {
	return unwrap(await fetch(`${root()}/v1/agents/${encodeURIComponent(agentId)}/diff`));
}
