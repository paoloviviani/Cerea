/**
 * What a failed document shows. The stored error is whatever the indexing run
 * met, kept as it was then. A quota refusal arrives in the gateway's own
 * wording ("Quota exceeded. global per user limit of 0.500000000000 cost per
 * month exceeded (current 0.500225765)"), which the user should never read: it
 * becomes one plain sentence in the past tense, since the limit may have
 * changed or reset since. Applied when the error is shown, so rows stored
 * before this existed read the same way.
 */
const QUOTA = /^(\d{3}\s+)?Quota exceeded\./i;

export function indexErrorForUser(stored: string | null | undefined): string | null {
	if (!stored) return null;
	if (QUOTA.test(stored.trim())) {
		return "Not indexed: the usage allowance had run out when this was indexed. Reindex to try again.";
	}
	return stored;
}
