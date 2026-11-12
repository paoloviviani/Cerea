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
	/** The kept page's address without query or fragment (for "is this the same site?"), when known. */
	url(deviceId: string, userId: ObjectId, conversationId: string): Promise<string | undefined>;
	get(deviceId: string, userId: ObjectId, conversationId: string): Promise<string | undefined>;
	/** Forget the conversation's kept page on every computer of the user's but this one (one write). */
	clearOthers(userId: ObjectId, conversationId: string, exceptDeviceId: string): Promise<void>;
	set(
		deviceId: string,
		userId: ObjectId,
		conversationId: string,
		kept: KeptPage | null
	): Promise<void>;
}

/** A tab lent to a conversation is resumed without asking for this long after the last task used it. */
export const LENT_IDLE_MS = 60 * 60_000;

/** The most conversations remembered per machine: the oldest are forgotten first. */
const MAX_PER_MACHINE = 20;

/** An address as it is remembered: no query, no fragment (they can carry tokens). */
function plainUrl(raw: string): string {
	try {
		const u = new URL(raw);
		return `${u.origin}${u.pathname}`;
	} catch {
		return "";
	}
}

export const mongoKeptStore: KeptStore = {
	async clearOthers(userId, conversationId, exceptDeviceId) {
		const { ObjectId } = await import("mongodb");
		await collections.codeDevices.updateMany(
			{
				userId,
				_id: { $ne: new ObjectId(exceptDeviceId) },
				[`browserKept.${conversationId}`]: { $exists: true },
			},
			{ $unset: { [`browserKept.${conversationId}`]: "" } }
		);
	},
	async url(deviceId, userId, conversationId) {
		const { ObjectId } = await import("mongodb");
		const device = await collections.codeDevices.findOne(
			{ _id: new ObjectId(deviceId), userId },
			{ projection: { browserKept: 1 } }
		);
		return device?.browserKept?.[conversationId]?.url || undefined;
	},
	async get(deviceId, userId, conversationId) {
		const { ObjectId } = await import("mongodb");
		const device = await collections.codeDevices.findOne(
			{ _id: new ObjectId(deviceId), userId },
			{ projection: { browserKept: 1 } }
		);
		const entry = device?.browserKept?.[conversationId];
		// A lent tab not used for an hour is a plain user tab again (the runtime lets its token lapse too).
		if (entry?.lent && Date.now() - entry.at.getTime() > LENT_IDLE_MS) return undefined;
		return entry?.token;
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
			{
				$set: {
					[`browserKept.${conversationId}`]: {
						token: kept.token,
						url: plainUrl(kept.url),
						at: new Date(),
						...(kept.lent ? { lent: true, site: kept.site ?? "" } : {}),
					},
				},
			}
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
export function memoryKeptStore(
	now: () => number = Date.now
): KeptStore & { tokens: Map<string, string>; lent: Map<string, { site: string; at: number }> } {
	const tokens = new Map<string, string>();
	const lent = new Map<string, { site: string; at: number }>();
	const urls = new Map<string, string>();
	const key = (d: string, c: string) => `${d}:${c}`;
	return {
		tokens,
		lent,
		async clearOthers(_userId, conversationId, exceptDeviceId) {
			for (const k of [...tokens.keys()]) {
				const [device, conv] = k.split(":");
				if (conv === conversationId && device !== exceptDeviceId) {
					tokens.delete(k);
					urls.delete(k);
					lent.delete(k);
				}
			}
		},
		async url(deviceId, _userId, conversationId) {
			return urls.get(key(deviceId, conversationId));
		},
		async get(deviceId, _userId, conversationId) {
			const k = key(deviceId, conversationId);
			const l = lent.get(k);
			if (l && now() - l.at > LENT_IDLE_MS) return undefined;
			return tokens.get(k);
		},
		async set(deviceId, _userId, conversationId, kept) {
			if (kept) {
				tokens.set(key(deviceId, conversationId), kept.token);
				urls.set(key(deviceId, conversationId), plainUrl(kept.url));
				if (kept.lent)
					lent.set(key(deviceId, conversationId), { site: kept.site ?? "", at: now() });
				else lent.delete(key(deviceId, conversationId));
			} else {
				tokens.delete(key(deviceId, conversationId));
				urls.delete(key(deviceId, conversationId));
				lent.delete(key(deviceId, conversationId));
			}
		},
	};
}
