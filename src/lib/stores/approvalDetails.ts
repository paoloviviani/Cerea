/**
 * Which approval cards have "Show details" open, keyed by conversation and elicitation id.
 * The first turn's message id is swapped for the server's after the stream, which remounts the
 * card; a key that does not change with the message id lets the card reopen as it was.
 */
const open = new Set<string>();

const keyOf = (conversationId: string, elicitationId: string) =>
	`${conversationId}:${elicitationId}`;

export function isDetailsOpen(conversationId: string, elicitationId: string): boolean {
	return open.has(keyOf(conversationId, elicitationId));
}

export function setDetailsOpen(
	conversationId: string,
	elicitationId: string,
	value: boolean
): void {
	const key = keyOf(conversationId, elicitationId);
	if (value) open.add(key);
	else open.delete(key);
}
