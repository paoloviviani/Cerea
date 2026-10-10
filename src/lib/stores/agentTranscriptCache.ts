import type { Message } from "$lib/types/Message";
import type { AgentCompactionUpdate, AgentUsageUpdate } from "$lib/types/CodeAgent";

/**
 * The /code panel's recent transcripts, kept in this tab's memory so that
 * going back to a session shows it at once (stale-while-revalidate): the view
 * renders the cached copy, replays the machine's log off-screen, and swaps the
 * fresh transcript in when the replay completes.
 *
 * Memory only, on purpose: a transcript is large and private, so nothing here
 * is written to localStorage or IndexedDB, and a reload or sign-out starts
 * empty. Values are plain snapshots (`$state.snapshot`), never live proxies.
 */

/** How many sessions are kept; the least recently used one goes first. */
export const TRANSCRIPT_CACHE_SESSIONS = 8;
/** How many messages one entry keeps (the newest). A longer transcript is
 * trimmed from the top and marked as having older messages. */
export const TRANSCRIPT_CACHE_MESSAGES = 400;

export interface TranscriptSnapshot {
	messages: Message[];
	/** Whether older messages exist behind the first one (null: unknown). */
	hasMore: boolean | null;
	/** The cursor older pages continue from. */
	before: string | null;
	usage: AgentUsageUpdate["usage"] | null;
	lastCompaction: AgentCompactionUpdate | null;
}

export const transcriptKey = (deviceId: string, agentId: string) => `${deviceId}:${agentId}`;

const entries = new Map<string, TranscriptSnapshot>();
/** Sessions deleted or archived: a view still unmounting must not put them
 * back. Session ids are unique, so a tombstone never blocks a live session. */
const forgotten = new Set<string>();
const FORGOTTEN_MAX = 64;

/** The cached transcript, marked most recently used; undefined on a miss. */
export function getTranscript(key: string): TranscriptSnapshot | undefined {
	const hit = entries.get(key);
	if (!hit) return undefined;
	entries.delete(key);
	entries.set(key, hit);
	return hit;
}

/** Store a snapshot (the caller passes plain data). An empty transcript is
 * not worth a hit and removes the entry instead. */
export function putTranscript(key: string, snapshot: TranscriptSnapshot): void {
	if (forgotten.has(key)) return;
	if (snapshot.messages.length === 0) {
		entries.delete(key);
		return;
	}
	let { messages, hasMore } = snapshot;
	let before = snapshot.before;
	if (messages.length > TRANSCRIPT_CACHE_MESSAGES) {
		messages = messages.slice(-TRANSCRIPT_CACHE_MESSAGES);
		hasMore = true;
		before = messages[0]?.machineMessageId ?? before;
	}
	entries.delete(key);
	entries.set(key, { ...snapshot, messages, hasMore, before });
	while (entries.size > TRANSCRIPT_CACHE_SESSIONS) {
		const oldest = entries.keys().next().value;
		if (oldest === undefined) break;
		entries.delete(oldest);
	}
}

/** Drop one entry (a rollback, a new epoch): the next open replays cold. */
export function dropTranscript(key: string): void {
	entries.delete(key);
}

/** Drop an entry for good (the session was deleted or archived). */
export function forgetTranscript(key: string): void {
	entries.delete(key);
	forgotten.add(key);
	if (forgotten.size > FORGOTTEN_MAX) {
		const oldest = forgotten.values().next().value;
		if (oldest !== undefined) forgotten.delete(oldest);
	}
}

/** Drop everything (sign-out). */
export function clearTranscripts(): void {
	entries.clear();
	forgotten.clear();
}
