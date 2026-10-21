/**
 * The conversation-scoped cache of text `web_fetch` has extracted (see
 * `WebFetchCacheEntry`). The per-turn `Map` in `webFetchTool.ts` stays the
 * first, in-memory layer; this is the second, which survives the turn.
 *
 * Bounds, so it cannot grow without limit: rows expire after
 * `CHAT_WEBFETCH_CACHE_DAYS` (default 7; 0 turns the cache off), one entry
 * holds at most `MAX_ENTRY_CHARS` of text (a bigger document is served but
 * not kept), and one conversation holds at most `MAX_CONVERSATION_BYTES` and
 * `MAX_CONVERSATION_ENTRIES`, the oldest fetched going first.
 */
import { createHash } from "node:crypto";
import type { ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import type { WebFetchCacheEntry } from "$lib/types/WebFetchCache";

export const DEFAULT_CACHE_DAYS = 7;
export const MAX_CACHE_DAYS = 365;
export const DEFAULT_FRESH_MINUTES = 10;
export const MAX_ENTRY_CHARS = 1_000_000;
export const MAX_CONVERSATION_BYTES = 8 * 1024 * 1024;
export const MAX_CONVERSATION_ENTRIES = 20;

export interface CacheScope {
	conversationId: ObjectId;
	userId?: ObjectId;
}

function wholeNumber(value: string | undefined, fallback: number, max: number): number {
	const raw = (value ?? "").trim();
	if (!/^\d+$/.test(raw)) return fallback;
	return Math.min(Number(raw), max);
}

/** Days a cached text is kept; 0 disables the cache. An unreadable value is the default. */
export function cacheDays(): number {
	return wholeNumber(config.CHAT_WEBFETCH_CACHE_DAYS, DEFAULT_CACHE_DAYS, MAX_CACHE_DAYS);
}

/** Milliseconds within which a cached text is reused without downloading again. */
export function freshWindowMs(): number {
	return wholeNumber(config.CHAT_WEBFETCH_FRESH_MINUTES, DEFAULT_FRESH_MINUTES, 24 * 60) * 60_000;
}

export function sha256Hex(data: ArrayBuffer | string): string {
	return createHash("sha256")
		.update(typeof data === "string" ? data : new Uint8Array(data))
		.digest("hex");
}

function scopeFilter(scope: CacheScope, url: string) {
	return {
		conversationId: scope.conversationId,
		url,
		userId: scope.userId ?? { $exists: false },
	};
}

/** The live entry for this conversation, owner and URL, or null. */
export async function getCachedFetch(
	scope: CacheScope,
	url: string,
	now = new Date()
): Promise<WebFetchCacheEntry | null> {
	if (cacheDays() === 0) return null;
	// The TTL monitor runs about once a minute; an expired row is not served meanwhile.
	return collections.webFetchCache.findOne({
		...scopeFilter(scope, url),
		expiresAt: { $gt: now },
	} as never);
}

export type NewCacheEntry = Pick<
	WebFetchCacheEntry,
	"finalUrl" | "title" | "text" | "contentHash" | "contentType" | "extractedBy"
>;

/**
 * Stores (or replaces) the entry, then trims the conversation to its caps.
 * Returns false when the text is over the per-entry or per-conversation cap
 * and so was not kept (an existing entry for the URL is dropped then, as it
 * is stale).
 */
export async function putCachedFetch(
	scope: CacheScope,
	url: string,
	entry: NewCacheEntry,
	now = new Date()
): Promise<boolean> {
	const days = cacheDays();
	if (days === 0) return false;
	const textBytes = Buffer.byteLength(entry.text, "utf8");
	if (entry.text.length > MAX_ENTRY_CHARS || textBytes > MAX_CONVERSATION_BYTES) {
		await collections.webFetchCache.deleteOne(scopeFilter(scope, url) as never);
		return false;
	}
	// Equality fields of the filter (conversation, URL, owner) seed an inserted row.
	await collections.webFetchCache.updateOne(
		scopeFilter(scope, url) as never,
		{
			$set: {
				...entry,
				textBytes,
				fetchedAt: now,
				extractedAt: now,
				expiresAt: new Date(now.getTime() + days * 86_400_000),
			},
		} as never,
		{ upsert: true }
	);
	await trimConversation(scope.conversationId, url);
	return true;
}

/** The bytes were downloaded again and matched: the text stays, the clock restarts. */
export async function refreshCachedFetch(
	scope: CacheScope,
	url: string,
	now = new Date()
): Promise<void> {
	const days = cacheDays();
	if (days === 0) return;
	await collections.webFetchCache.updateOne(scopeFilter(scope, url) as never, {
		$set: { fetchedAt: now, expiresAt: new Date(now.getTime() + days * 86_400_000) },
	});
}

/** Oldest-fetched first, never the entry just written. */
async function trimConversation(conversationId: ObjectId, keepUrl: string): Promise<void> {
	const rows = await collections.webFetchCache
		.find({ conversationId })
		.project<Pick<WebFetchCacheEntry, "_id" | "url" | "textBytes">>({
			_id: 1,
			url: 1,
			textBytes: 1,
		})
		.sort({ fetchedAt: 1 })
		.toArray();
	let total = rows.reduce((sum, row) => sum + row.textBytes, 0);
	let count = rows.length;
	const drop: ObjectId[] = [];
	for (const row of rows) {
		if (total <= MAX_CONVERSATION_BYTES && count <= MAX_CONVERSATION_ENTRIES) break;
		if (row.url === keepUrl) continue;
		drop.push(row._id);
		total -= row.textBytes;
		count -= 1;
	}
	if (drop.length > 0) await collections.webFetchCache.deleteMany({ _id: { $in: drop } });
}

/** Deleted with the conversation(s): see `deleteConversationStorage`. */
export async function deleteConversationWebFetchCache(
	conversationId: ObjectId | ObjectId[]
): Promise<void> {
	const ids = Array.isArray(conversationId) ? conversationId : [conversationId];
	if (ids.length === 0) return;
	const { deletedCount } = await collections.webFetchCache.deleteMany({
		conversationId: { $in: ids },
	});
	if (deletedCount > 0) logger.debug({ deletedCount }, "web_fetch_cache_deleted_with_conversation");
}
