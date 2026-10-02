/**
 * Unsent composer text, kept on this device only.
 *
 * Both composers — chat's `ChatInput` (keyed per conversation) and the /code
 * agent composer (keyed per device+agent) — persist their draft here, in
 * `localStorage`, so an unsent message survives reloads and navigation.
 * Nothing here ever leaves the device: no server round-trip, no sync.
 * Attachments, the model picker and every other composer state are
 * deliberately not persisted.
 *
 * Every access is guarded: storage may be unavailable (private mode) or full,
 * and neither must ever break the composer. Writes over the size cap are
 * truncated rather than refused, so a long paste degrades to a shorter
 * restored draft instead of losing the whole one.
 */

/** Storage prefix. Keys are `${PREFIX}${scope}:${id}` — see the key helpers. */
export const COMPOSER_DRAFT_PREFIX = "cerea:composer-draft:";

/**
 * Longest draft kept, in characters (~40KB as UTF-16). A paste longer than
 * this still restores its head; the cap only bounds what one key may hold so
 * quota errors stay unreachable in practice.
 */
export const COMPOSER_DRAFT_MAX_CHARS = 20_000;

/** Idle time after the last keystroke before the draft is written. */
export const COMPOSER_DRAFT_DEBOUNCE_MS = 400;

/** Chat's key: one draft per conversation, plus `home` before one exists. */
export function chatDraftKey(conversationId?: string | null): string {
	return `${COMPOSER_DRAFT_PREFIX}chat:${conversationId || "home"}`;
}

/** The /code agent composer's key: one draft per device+agent. */
export function codeDraftKey(deviceId: string, agentId: string): string {
	return `${COMPOSER_DRAFT_PREFIX}code:${deviceId}:${agentId}`;
}

/** The stored draft, or null when there is none (or storage is unreadable). */
export function readComposerDraft(key: string): string | null {
	try {
		const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
		if (!stored) return null;
		return stored;
	} catch {
		return null;
	}
}

/** Stores the draft, truncated to the cap. Never throws. */
export function writeComposerDraft(key: string, text: string): void {
	try {
		if (typeof localStorage === "undefined") return;
		if (!text) {
			localStorage.removeItem(key);
			return;
		}
		const capped =
			text.length > COMPOSER_DRAFT_MAX_CHARS ? text.slice(0, COMPOSER_DRAFT_MAX_CHARS) : text;
		localStorage.setItem(key, capped);
	} catch {
		// Quota or unavailable storage: the composer keeps working, the draft
		// just does not survive a reload.
	}
}

/** Drops the stored draft, e.g. after a send landed. Never throws. */
export function clearComposerDraft(key: string): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.removeItem(key);
	} catch {
		// Unavailable storage: nothing stored, nothing to clear.
	}
}

/**
 * Drops every stored draft. Called on sign-out, before the `POST /logout` —
 * drafts are per-device state, and on a shared browser the next person must
 * not see the previous person's unsent text. Never throws; keys outside the
 * prefix (theme, MCP selections, …) are left alone.
 */
export function clearAllComposerDrafts(): void {
	try {
		if (typeof localStorage === "undefined") return;
		for (const key of Object.keys(localStorage)) {
			if (key.startsWith(COMPOSER_DRAFT_PREFIX)) localStorage.removeItem(key);
		}
	} catch {
		// Unavailable storage: nothing stored, nothing to clear — and sign-out
		// itself must never fail because of this.
	}
}
