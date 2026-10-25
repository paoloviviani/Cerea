/**
 * Which knowledge bases are a project's chat memory.
 *
 * A project that indexes its past chats keeps them in a base the server
 * creates (`Project.memoryBaseId`, see `$lib/server/projects`). It is a row in
 * the same collection as every base a person makes, so without a check it
 * shows up in pickers and could be attached to a project as an ordinary
 * knowledge base — its own project included, which would search the memory
 * twice or feed it back into itself.
 *
 * The one source of truth is `projects.memoryBaseId`: it is set only by the
 * server and exists on every project that ever had a memory base, so it works
 * for bases created before this check did. Everything that must keep memory
 * bases out of a list of attachable bases goes through this file.
 */

import { ObjectId } from "mongodb";
import { error } from "@sveltejs/kit";
import { collections } from "$lib/server/database";

/** The project a memory base belongs to. */
export interface MemoryBaseOwner {
	projectId: string;
	projectName: string;
}

/** Every memory base, by store id, with its project. One query. */
export async function memoryBaseOwners(): Promise<Map<string, MemoryBaseOwner>> {
	const rows = await collections.projects
		.find(
			{ memoryBaseId: { $exists: true, $ne: "" } },
			{ projection: { name: 1, memoryBaseId: 1 } }
		)
		.toArray();
	const owners = new Map<string, MemoryBaseOwner>();
	for (const row of rows) {
		if (row.memoryBaseId) {
			owners.set(row.memoryBaseId, { projectId: row._id.toString(), projectName: row.name });
		}
	}
	return owners;
}

/** The project this store is the memory of, or `undefined` for an ordinary base. */
export async function memoryBaseOwner(storeId: string): Promise<MemoryBaseOwner | undefined> {
	if (!ObjectId.isValid(storeId)) return undefined;
	const row = await collections.projects.findOne(
		{ memoryBaseId: storeId },
		{ projection: { name: 1 } }
	);
	return row ? { projectId: row._id.toString(), projectName: row.name } : undefined;
}

/** Whether this store id is some project's chat memory. */
export async function isMemoryBase(storeId: string): Promise<boolean> {
	return (await memoryBaseOwner(storeId)) !== undefined;
}

/** The ids that are memory bases, from a list. One query whatever the length. */
async function memoryIdsAmong(ids: string[]): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const rows = await collections.projects
		.find({ memoryBaseId: { $in: ids } }, { projection: { memoryBaseId: 1 } })
		.toArray();
	return new Set(rows.flatMap((row) => (row.memoryBaseId ? [row.memoryBaseId] : [])));
}

/** `ids` without any project's memory base, order kept. For reads and retrieval. */
export async function withoutMemoryBases(ids: string[]): Promise<string[]> {
	const memory = await memoryIdsAmong(ids);
	return memory.size === 0 ? ids : ids.filter((id) => !memory.has(id));
}

/** A 400 when any id is a memory base: the one check every attach route calls. */
export async function rejectMemoryBases(ids: string[]): Promise<void> {
	const memory = await memoryIdsAmong(ids);
	if (memory.size > 0) {
		error(
			400,
			"A project's chat memory cannot be attached as a knowledge base. Choose another knowledge base."
		);
	}
}
