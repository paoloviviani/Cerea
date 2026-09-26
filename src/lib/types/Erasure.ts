/**
 * One erasure run (ADR 0093 §9.3), keyed by the gateway's own `erasure_id` so
 * a retried delivery (the gateway backs off and retries until the chat
 * confirms) is idempotent: a repeat after `doneAt` returns the recorded
 * counts, and a repeat after a crash resumes from the ids already recorded
 * here rather than re-resolving them.
 */
export interface ErasureRecord {
	_id: string;
	gatewayUserId: string;
	identities: { issuer: string; subject: string }[];
	/** Every chat user row this run erases (the target plus any stray still
	 * unmerged or mid-merge) — resolved once, at the start. */
	userIds: string[];
	/** Every one of those users' conversation ids, resolved before anything
	 * is deleted so a conversation-keyed collection can still be swept after
	 * the conversations themselves are gone. */
	conversationIds: string[];
	/** Every one of those users' `/code` device ids, resolved up front for
	 * the same reason, and so the live-link close-out survives a crash too. */
	deviceIds: string[];
	startedAt: Date;
	doneAt: Date | null;
	counts: Record<string, number>;
}
