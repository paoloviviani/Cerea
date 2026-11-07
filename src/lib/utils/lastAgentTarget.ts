/**
 * The machine and folder a user last started an agent session on, so "New agent
 * session" opens already pointing at it. Per browser: a convenience, never state
 * that must survive (every read and write tolerates storage being unavailable).
 */
const KEY = "cerea.lastAgentTarget";

export interface LastAgentTarget {
	deviceId: string;
	workspaceId: string;
}

export function readLastAgentTarget(): LastAgentTarget | null {
	try {
		const parsed = JSON.parse(
			localStorage.getItem(KEY) ?? "null"
		) as Partial<LastAgentTarget> | null;
		return parsed?.deviceId && parsed.workspaceId
			? { deviceId: parsed.deviceId, workspaceId: parsed.workspaceId }
			: null;
	} catch {
		return null;
	}
}

export function writeLastAgentTarget(target: LastAgentTarget): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(target));
	} catch {
		// Private window or blocked storage: the dialog just opens on the first machine.
	}
}
