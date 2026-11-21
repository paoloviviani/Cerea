import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { recordCodeAuditRow } from "$lib/server/code/audit";
import type { CodeRelayTicket, RelayCardFacts } from "$lib/types/CodeRelay";

/**
 * The approval ticket (ADR 0121 section 5): Cerea, not galopin, proves the owner approved.
 *
 * - **Written at ask time** (`recordTicket`), as `asked`, with the facts the card shows and the
 *   hash of what the call will carry.
 * - **Minted only in the HTTP `permission.reply` route**, before the reply is forwarded
 *   (`approveTicket`): `asked` to `approved` atomically, for a signed-in owner answering `once`.
 *   Never in `MachineLink.permissionReply`, so the reviewer's and the rules' replies cannot mint.
 *   Deleted if forwarding fails (`revokeTicket`), on a reject (`rejectTicket`), on expiry.
 * - **Consumed once** by the `coord.send|read|spawn` call (`consumeTicket`): an atomic delete, so
 *   two calls racing for one ticket cannot both have it.
 *
 * It lives in Mongo with a TTL: a Cerea restart between ask and answer, or answer and call, loses
 * nothing.
 */

/** A card waits this long for an answer before its ticket expires. */
export const ASKED_TTL_MS = 6 * 60 * 60 * 1000;
/** An approved ticket is good for this long after the answer. */
export const APPROVED_TTL_MS = 2 * 60 * 1000;

export interface NewTicket {
	userId: ObjectId;
	deviceId: string;
	requestId: string;
	callerSessionId: string;
	hash: string;
	facts: RelayCardFacts;
}

/** Write the ticket of a card just asked. A second ask with the same id changes nothing. */
export async function recordTicket(t: NewTicket, now = Date.now()): Promise<CodeRelayTicket> {
	const doc: CodeRelayTicket = {
		_id: new ObjectId(),
		deviceId: t.deviceId,
		userId: t.userId,
		requestId: t.requestId,
		hash: t.hash,
		callerSessionId: t.callerSessionId,
		facts: t.facts,
		state: "asked",
		askedAt: new Date(now),
		expiresAt: new Date(now + ASKED_TTL_MS),
	};
	const existing = await collections.codeRelayTickets.findOneAndUpdate(
		{ deviceId: t.deviceId, requestId: t.requestId },
		{ $setOnInsert: doc },
		{ upsert: true, returnDocument: "after", includeResultMetadata: false }
	);
	return existing ?? doc;
}

export function findTicket(deviceId: string, requestId: string): Promise<CodeRelayTicket | null> {
	return collections.codeRelayTickets.findOne({ deviceId, requestId });
}

async function auditApproval(
	ticket: CodeRelayTicket,
	outcome: "approved" | "rejected" | "expired"
): Promise<void> {
	await recordCodeAuditRow(ticket.userId, {
		action: "coord.approval",
		deviceId: ticket.deviceId,
		sessionId: ticket.callerSessionId,
		approvalId: ticket.requestId,
		name: ticket.facts.op,
		origin: "agent",
		outcome,
	});
}

/**
 * Mint: move the owner's own `asked` ticket to `approved`, atomically. Returns the ticket, or null
 * when there is none to move (no record, another owner's, already answered, expired): in which
 * case nothing was minted. Called by the HTTP reply route alone.
 */
export async function approveTicket(
	userId: ObjectId,
	deviceId: string,
	requestId: string,
	/** The session the answer is for: the ticket's caller session. */
	sessionId: string,
	/** The hash the card carried: the owner's answer binds to the very card they saw. */
	hash: string | undefined,
	now = Date.now()
): Promise<CodeRelayTicket | null> {
	const ticket = await collections.codeRelayTickets.findOneAndUpdate(
		{
			deviceId,
			requestId,
			userId,
			callerSessionId: sessionId,
			hash: hash ?? "\u0000none",
			state: "asked",
			expiresAt: { $gt: new Date(now) },
		},
		{
			$set: {
				state: "approved",
				approvedAt: new Date(now),
				approvedBy: userId,
				expiresAt: new Date(now + APPROVED_TTL_MS),
			},
		},
		{ returnDocument: "after", includeResultMetadata: false }
	);
	if (ticket) await auditApproval(ticket, "approved");
	return ticket;
}

/**
 * Tombstone a ticket: the id was asked again with something else. The record stays (same TTL), so
 * `recordTicket` never writes a fresh one for it and `approveTicket` never finds it `asked`.
 */
export async function spoilTicket(
	deviceId: string,
	requestId: string,
	now = Date.now()
): Promise<void> {
	await collections.codeRelayTickets.updateOne(
		{ deviceId, requestId },
		{ $set: { state: "spoiled", expiresAt: new Date(now + ASKED_TTL_MS) } }
	);
}

/** Revoke a ticket whose approval could not be forwarded, or whose ask was answered elsewhere. */
export async function revokeTicket(deviceId: string, requestId: string): Promise<void> {
	await collections.codeRelayTickets.deleteOne({ deviceId, requestId });
}

/** A reject deletes the record, and says so in the audit. */
export async function rejectTicket(
	userId: ObjectId,
	deviceId: string,
	requestId: string
): Promise<void> {
	const ticket = await collections.codeRelayTickets.findOneAndDelete(
		{ deviceId, requestId, userId },
		{ includeResultMetadata: false }
	);
	if (ticket) await auditApproval(ticket, "rejected");
}

/**
 * Consume: delete the device's own approved, unexpired ticket and return it. Atomic, so a ticket
 * serves one call. A ticket that has expired but not yet been swept is not served, and is audited
 * as expired.
 */
export async function consumeTicket(
	deviceId: string,
	requestId: string,
	now = Date.now()
): Promise<CodeRelayTicket | null> {
	const ticket = await collections.codeRelayTickets.findOneAndDelete(
		{ deviceId, requestId, state: "approved", expiresAt: { $gt: new Date(now) } },
		{ includeResultMetadata: false }
	);
	if (ticket) return ticket;
	const stale = await collections.codeRelayTickets.findOneAndDelete(
		{ deviceId, requestId, expiresAt: { $lte: new Date(now) } },
		{ includeResultMetadata: false }
	);
	if (stale) await auditApproval(stale, "expired");
	return null;
}

/** Delete every open ticket of a user (the switch went off), audited as expired. */
export async function deleteTicketsOf(userId: ObjectId): Promise<number> {
	const open = await collections.codeRelayTickets.find({ userId }).toArray();
	if (open.length === 0) return 0;
	const res = await collections.codeRelayTickets.deleteMany({ userId });
	for (const ticket of open) await auditApproval(ticket, "expired");
	return res.deletedCount;
}

/** Delete expired tickets now and audit each as expired (the TTL index also removes them, silently). */
export async function sweepExpiredTickets(now = Date.now()): Promise<number> {
	const expired = await collections.codeRelayTickets
		.find({ expiresAt: { $lte: new Date(now) } })
		.limit(200)
		.toArray();
	let n = 0;
	for (const ticket of expired) {
		const res = await collections.codeRelayTickets.deleteOne({ _id: ticket._id });
		if (res.deletedCount) {
			n += 1;
			await auditApproval(ticket, "expired");
		}
	}
	return n;
}

/** Start the loop that audits expiries; unref'd so it never holds the process open. */
export function startRelaySweepLoop(everyMs = 60_000): () => void {
	const timer = setInterval(() => {
		sweepExpiredTickets().catch((err) =>
			logger.warn({ err: String(err) }, "relay: ticket sweep failed")
		);
	}, everyMs);
	(timer as { unref?: () => void }).unref?.();
	return () => clearInterval(timer);
}
