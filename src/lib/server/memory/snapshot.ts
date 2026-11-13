/**
 * Personal and project memory, frozen per conversation for the prompt cache.
 *
 * A provider's prompt cache matches a byte-identical prefix of the request. If
 * the memory blocks sat in the system prompt as live reads, every edit to a
 * fact or a project note would change the prefix and throw away the cache for
 * the whole history. So a conversation takes a **snapshot** of both lists on
 * its first turn that has any memory available, keeps it on the conversation,
 * and renders the system-prompt blocks from the snapshot on every turn: the
 * same bytes until the chat ends.
 *
 * A write made after the snapshot (the user or the assistant adding, editing or
 * removing a fact or a project note) must still reach the model. It does, in
 * the tail of the request next to the chat's own notes (`memoryUpdatesBlock`,
 * injected before the newest user message), until a new conversation takes a
 * fresh snapshot. Nothing before the tail ever changes.
 *
 * The snapshot keeps every row's id and, for the rows that fit the block's
 * budget, its text. An older row that did not fit stays out of the prompt and
 * is not reported as an update either.
 *
 * It is retaken (one cache miss) only when the shape of what is available
 * changes: the chat moves into or out of a project, or the user switches
 * personal memory on or off. Those are configuration, not writes.
 */

import type { ObjectId } from "mongodb";
import { fitMemoriesToBudget } from "$lib/utils/memoryBudget";
import {
	listMemories,
	listProjectMemories,
	MEMORY_BLOCK_MAX_CHARS,
	PROJECT_MEMORY_BLOCK_MAX_CHARS,
	renderMemoryBlock,
	renderProjectMemoryBlock,
} from "$lib/server/memory/service";

interface SnapshotRow {
	id: string;
	/** Present for rows that fit the prompt budget. */
	text?: string;
}

export interface MemorySnapshot {
	/** Whether personal memory was on when it was taken. */
	globalOn: boolean;
	global: SnapshotRow[];
	/** The project whose notes were taken, when there was one. */
	projectId?: string;
	project: SnapshotRow[];
	takenAt: Date;
}

/** What is available to this turn; compared with a snapshot to decide whether it still applies. */
export interface MemoryAvailability {
	userId: ObjectId | undefined;
	globalOn: boolean;
	projectId?: ObjectId;
}

function rowsOf(rows: { _id: ObjectId; text: string }[], budget: number): SnapshotRow[] {
	const { included } = fitMemoriesToBudget(
		rows.map((row) => row.text),
		budget
	);
	const keep = new Set(included);
	return rows.map((row, index) => ({
		id: row._id.toString(),
		...(keep.has(index) ? { text: row.text } : {}),
	}));
}

export async function takeMemorySnapshot(available: MemoryAvailability): Promise<MemorySnapshot> {
	const [global, project] = await Promise.all([
		available.userId && available.globalOn ? listMemories(available.userId) : [],
		available.projectId ? listProjectMemories(available.projectId) : [],
	]);
	return {
		globalOn: available.globalOn,
		global: rowsOf(global, MEMORY_BLOCK_MAX_CHARS),
		...(available.projectId ? { projectId: available.projectId.toString() } : {}),
		project: rowsOf(project, PROJECT_MEMORY_BLOCK_MAX_CHARS),
		takenAt: new Date(),
	};
}

/** Whether the snapshot was taken under the same configuration as this turn's. */
export function snapshotApplies(
	snapshot: MemorySnapshot | undefined,
	available: MemoryAvailability
): snapshot is MemorySnapshot {
	return (
		snapshot !== undefined &&
		snapshot.globalOn === available.globalOn &&
		(snapshot.projectId ?? undefined) === (available.projectId?.toString() ?? undefined)
	);
}

const texts = (rows: SnapshotRow[]) =>
	rows.flatMap((row) => (row.text !== undefined ? [row.text] : []));

/** The two system-prompt blocks, from the snapshot alone. Pure. */
export function snapshotBlocks(snapshot: MemorySnapshot): {
	global: string | undefined;
	project: string | undefined;
} {
	return {
		global: snapshot.globalOn ? renderMemoryBlock(texts(snapshot.global)) : undefined,
		project: snapshot.projectId ? renderProjectMemoryBlock(texts(snapshot.project)) : undefined,
	};
}

/** The most the updates may take of the tail, in characters. */
export const MEMORY_UPDATES_MAX_CHARS = 3000;

interface CurrentRow {
	_id: ObjectId;
	text: string;
}

function diff(snapshot: SnapshotRow[], current: CurrentRow[]): string[] {
	const before = new Map(snapshot.map((row) => [row.id, row.text]));
	const now = new Set(current.map((row) => row._id.toString()));
	const lines: string[] = [];
	for (const row of current) {
		const id = row._id.toString();
		if (!before.has(id)) lines.push(`- added: ${row.text}`);
		else {
			const old = before.get(id);
			if (old !== undefined && old !== row.text) lines.push(`- now reads: ${row.text}`);
		}
	}
	for (const row of snapshot) {
		if (!now.has(row.id) && row.text !== undefined) lines.push(`- removed: ${row.text}`);
	}
	return lines;
}

/**
 * What changed in personal and project memory since the snapshot, for the tail
 * of the request; `undefined` when nothing did. Pure in its inputs: creation
 * order, no times, so the same state renders the same bytes on every turn.
 */
export function memoryUpdatesBlock(
	snapshot: MemorySnapshot,
	current: { global?: CurrentRow[]; project?: CurrentRow[] }
): string | undefined {
	const sections: string[] = [];
	const globalLines = current.global ? diff(snapshot.global, current.global) : [];
	const projectLines = current.project ? diff(snapshot.project, current.project) : [];
	if (globalLines.length > 0) sections.push(`About the user:\n${globalLines.join("\n")}`);
	if (projectLines.length > 0) sections.push(`Project notes:\n${projectLines.join("\n")}`);
	if (sections.length === 0) return undefined;
	let body = sections.join("\n");
	if (body.length > MEMORY_UPDATES_MAX_CHARS) {
		body = `${body.slice(0, MEMORY_UPDATES_MAX_CHARS)}\n…(more changes not shown)`;
	}
	return (
		"[UPDATED IN THIS CONVERSATION: changes to the standing memory shown at the start, made after " +
		"this chat began. They replace what the memory above says on the same point.]\n" +
		body
	);
}
