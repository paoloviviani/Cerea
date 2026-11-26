/**
 * Which connector keeps a name when several share it (C169).
 *
 * The model's tool dispatch is keyed by connector name, so a turn must never offer two
 * connectors with one name. Names are compared with `connectorNameKey`. The deployment's
 * connector wins over a user's, a user's over one on a computer, and of two of a kind the
 * older wins (an `.env` server counts as oldest), else the lower key. One pure function,
 * so a turn (`resolveConnectors`) and the connector lists agree on the winner.
 */

import { connectorNameKey } from "$lib/utils/connectorName";

export interface NameCandidate {
	key: string;
	name: string;
	/** An `.env` server or an administrator's row. */
	deployment: boolean;
	/** On a user's computer. */
	local?: boolean;
	/** Epoch ms; absent sorts first (an `.env` server). */
	createdAt?: number;
}

const rank = (c: NameCandidate) => (c.deployment ? 0 : c.local ? 2 : 1);

/** The keys that lose their name to another candidate, with the name of the one that won. */
export function nameClashLosers(candidates: NameCandidate[]): Map<string, string> {
	const order = [...candidates].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			(a.createdAt ?? -Infinity) - (b.createdAt ?? -Infinity) ||
			(a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
	);
	const winners = new Map<string, string>();
	const losers = new Map<string, string>();
	for (const c of order) {
		const name = connectorNameKey(c.name);
		const winner = winners.get(name);
		if (winner === undefined) winners.set(name, c.name);
		else losers.set(c.key, winner);
	}
	return losers;
}
