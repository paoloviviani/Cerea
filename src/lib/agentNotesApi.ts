import { base } from "$app/paths";
import type { AgentMemoryScope, AgentMemoryView } from "$lib/types/ScopedMemory";

/** Client for the code panel's notes routes (`/api/v2/code/memory`). */
export interface AgentNoteKey {
	deviceId: string;
	scope: AgentMemoryScope;
	key: string;
}

async function read<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const parsed = await response.json().catch(() => null);
		throw new Error(parsed?.message ?? `HTTP ${response.status}`);
	}
	return response.status === 204 ? (null as T) : ((await response.json()).data as T);
}

const query = (k: AgentNoteKey) =>
	`device=${encodeURIComponent(k.deviceId)}&scope=${k.scope}&key=${encodeURIComponent(k.key)}`;

export async function listAgentNotes(k: AgentNoteKey): Promise<AgentMemoryView[]> {
	const data = await read<{ notes: AgentMemoryView[] }>(
		await fetch(`${base}/api/v2/code/memory?${query(k)}`)
	);
	return data.notes;
}

const json = (body: unknown): RequestInit => ({
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

export async function addAgentNote(k: AgentNoteKey, text: string): Promise<AgentMemoryView> {
	return read(
		await fetch(`${base}/api/v2/code/memory`, { method: "POST", ...json({ ...k, text }) })
	);
}

export async function editAgentNote(
	k: AgentNoteKey,
	id: string,
	text: string
): Promise<AgentMemoryView> {
	return read(
		await fetch(`${base}/api/v2/code/memory/${id}`, { method: "PATCH", ...json({ ...k, text }) })
	);
}

export async function deleteAgentNote(k: AgentNoteKey, id: string): Promise<void> {
	await read(await fetch(`${base}/api/v2/code/memory/${id}?${query(k)}`, { method: "DELETE" }));
}
