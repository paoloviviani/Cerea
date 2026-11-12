/**
 * The page a browse task left open, per conversation and machine (ADR 0116).
 *
 * The token that resumes it stays on the server: it is kept on the machine's own row (a field per
 * conversation), is used only by the next `browse` of that conversation, and is never sent to a
 * model or to a client. A conversation that is not the one that left the page does not get it
 * (the page is then a user tab, adopted only with approval).
 */

import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import type { KeptPage } from "./loop";

export interface KeptStore {
	get(deviceId: string, userId: ObjectId, conversationId: string): Promise<string | undefined>;
	set(
		deviceId: string,
		userId: ObjectId,
		conversationId: string,
		kept: KeptPage | null
	): Promise<void>;
}

/** The most conversations remembered per machine: the oldest are forgotten first. */
const MAX_PER_MACHINE = 20;

export const mongoKeptStore: KeptStore = {
	async get(deviceId, userId, conversationId) {
		const { ObjectId } = await import("mongodb");
		const device = await collections.codeDevices.findOne(
			{ _id: new ObjectId(deviceId), userId },
			{ projection: { browserKept: 1 } }
		);
		return device?.browserKept?.[conversationId]?.token;
	},
	async set(deviceId, userId, conversationId, kept) {
		const { ObjectId } = await import("mongodb");
		const _id = new ObjectId(deviceId);
		if (!kept) {
			await collections.codeDevices.updateOne(
				{ _id, userId },
				{ $unset: { [`browserKept.${conversationId}`]: "" } }
			);
			return;
		}
		await collections.codeDevices.updateOne(
			{ _id, userId },
			{ $set: { [`browserKept.${conversationId}`]: { token: kept.token, at: new Date() } } }
		);
		const row = await collections.codeDevices.findOne(
			{ _id, userId },
			{ projection: { browserKept: 1 } }
		);
		const entries = Object.entries(row?.browserKept ?? {});
		if (entries.length > MAX_PER_MACHINE) {
			const oldest = entries
				.sort((a, b) => a[1].at.getTime() - b[1].at.getTime())
				.slice(0, entries.length - MAX_PER_MACHINE);
			await collections.codeDevices.updateOne(
				{ _id, userId },
				{ $unset: Object.fromEntries(oldest.map(([id]) => [`browserKept.${id}`, ""])) }
			);
		}
	},
};

/** In memory, for tests. */
export function memoryKeptStore(): KeptStore & { tokens: Map<string, string> } {
	const tokens = new Map<string, string>();
	const key = (d: string, c: string) => `${d}:${c}`;
	return {
		tokens,
		async get(deviceId, _userId, conversationId) {
			return tokens.get(key(deviceId, conversationId));
		},
		async set(deviceId, _userId, conversationId, kept) {
			if (kept) tokens.set(key(deviceId, conversationId), kept.token);
			else tokens.delete(key(deviceId, conversationId));
		},
	};
}
