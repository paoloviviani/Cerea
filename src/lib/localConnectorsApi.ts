/**
 * The browser's calls for the Local connectors tab and a local connector's sign-in (ADR 0102).
 * Plain JSON endpoints under `/api/v2/local-connectors`; the server checks that every machine
 * named here is the caller's own.
 */
import { base } from "$app/paths";
import type { LocalMachineView, LocalToolsAnswer } from "$lib/types/LocalConnectors";

export class LocalConnectorsApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** `reauth_required` when the sign-in is too old to approve a machine. */
		readonly code?: string
	) {
		super(message);
		this.name = "LocalConnectorsApiError";
	}
}

const root = () => `${base}/api/v2/local-connectors`;

async function unwrap<T>(response: Response): Promise<T> {
	if (response.ok) return (await response.json()) as T;
	const body = (await response.json().catch(() => null)) as {
		message?: string;
		error?: string;
		code?: string;
	} | null;
	throw new LocalConnectorsApiError(
		body?.message ?? body?.error ?? `The request failed (${response.status}).`,
		response.status,
		body?.code
	);
}

export async function listLocalMachines(): Promise<LocalMachineView[]> {
	const { machines } = await unwrap<{ machines: LocalMachineView[] }>(
		await fetch(root(), { signal: AbortSignal.timeout(20_000) })
	);
	return machines;
}

/**
 * The tool names of one of the person's own local servers, by connector id
 * (`local:<device>:<server>`). Resolves with `{ error }` when the server cannot be listed now.
 */
export async function listLocalServerTools(connectorId: string): Promise<LocalToolsAnswer> {
	return unwrap<LocalToolsAnswer>(
		await fetch(`${root()}/tools?id=${encodeURIComponent(connectorId)}`, {
			signal: AbortSignal.timeout(40_000),
		})
	);
}

/** Approve a machine that connected and is waiting: the fresh human confirmation. */
export async function confirmLocalMachine(id: string): Promise<void> {
	await unwrap(
		await fetch(`${root()}/machines/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "confirm" }),
		})
	);
}

/** Revoke a paired machine, or reject one still waiting: the same tombstoning action. */
export async function revokeLocalMachine(id: string): Promise<void> {
	await unwrap(await fetch(`${root()}/machines/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/** Start a local http connector's sign-in; resolves with the address to send the browser to. */
export async function startLocalSignIn(connectorId: string, next: string): Promise<string> {
	const { authorizeUrl } = await unwrap<{ authorizeUrl: string }>(
		await fetch(`${root()}/oauth/start`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ connectorId, next }),
		})
	);
	return authorizeUrl;
}
