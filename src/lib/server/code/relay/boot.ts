import { codeRelayedCoordinationEnabled } from "$lib/server/codeEnabled";
import { logger } from "$lib/server/logger";
import { chatReplicas } from "./facts";

/**
 * Relayed coordination needs the same single chat replica the machine links assume (ADR 0121
 * section 14): the registry of live links is per process, so a target connected to another
 * replica cannot be reached. Tickets, counters and the ledger are in Mongo; only the link lookup
 * stands in the way. Logged once at start-up.
 */
export function warnIfRelayNeedsSingleReplica(): void {
	if (!codeRelayedCoordinationEnabled()) return;
	const replicas = chatReplicas();
	if (replicas > 1) {
		logger.warn(
			{ replicas },
			"[relay] relayed coordination is on with more than one chat replica configured: a computer whose link is held by another replica is reported as unreachable from this server. Run one chat replica, or set CODE_RELAYED_COORDINATION_ENABLED=false."
		);
	}
}
