import type { ObjectId } from "mongodb";

/**
 * Relayed coordination (ADR 0121): the records Cerea keeps so that an agent on one of a user's
 * computers can read, message and start sessions on another, always after the owner approved
 * that exact call. Tickets, counters and the hop ledger live in Mongo, not in process memory, so
 * they survive a restart and hold across replicas later.
 */

export type RelayOp = "send" | "read" | "spawn";

/**
 * What a relay card shows, built by Cerea alone from its own records (the names come from
 * `coord.resolve`-style live reads, never from the asking galopin's metadata). The hash-covered
 * fields the card shows (the text or prompt) are the ones the ticket binds.
 */
export interface RelayCardFacts {
	op: RelayOp;
	hop: number;
	caller: { computer: string; workspace: string; session: string };
	target: {
		computer: string;
		workspace: string;
		/** send, read: the target session. */
		session?: string;
		/** The session's opencode mode (build, plan...). */
		agentMode?: string;
		/** The session's permission word: plan, ask, auto or allow. Looser than this at the
		 * call is refused. */
		word?: string;
		status?: string;
	};
	text?: string;
	prompt?: string;
	last?: number;
	title?: string;
	/** spawn: the agent mode it starts in. */
	mode?: string;
}

/** What the browser is given for a relay ask. `approvable: false` is "cannot be approved from here". */
export type RelayCardView =
	| ({ approvable: true; pending?: undefined; reason?: undefined } & RelayCardFacts)
	| { approvable: false; pending?: boolean; reason?: string };

export type RelayTicketState = "asked" | "approved";

/** One relay approval in flight: written at ask time, moved to `approved` by the owner's answer in
 * Cerea's own HTTP route, deleted when consumed, rejected, revoked or expired. */
export interface CodeRelayTicket {
	_id: ObjectId;
	deviceId: string;
	userId: ObjectId;
	/** The galopin card's id: also the call's `approvalId`. */
	requestId: string;
	/** sha-256 of the canonical JSON of the covered fields (op, target, content, hop, caller session). */
	hash: string;
	callerSessionId: string;
	facts: RelayCardFacts;
	state: RelayTicketState;
	askedAt: Date;
	approvedAt?: Date;
	approvedBy?: ObjectId;
	/** TTL: the pending card's lifetime while asked, 2 minutes after the answer once approved. */
	expiresAt: Date;
}

/** The hop and spawn depth of a TARGET session, written at each successful relayed delivery. */
export interface CodeRelayLedgerRow {
	/** `<deviceId>:<sessionId>` of the target session. */
	_id: string;
	userId: ObjectId;
	deviceId: string;
	sessionId: string;
	hop: number;
	depth: number;
	at: Date;
}

/** One counted event: a relayed call, a list, or a card asked. Short-lived. */
export interface CodeRelayEvent {
	_id: ObjectId;
	kind: "call" | "list" | "ask";
	/** For a call: send, read or spawn. */
	op?: string;
	userId: ObjectId;
	deviceId: string;
	at: Date;
}
