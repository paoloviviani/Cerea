/**
 * Terminal connect tickets (ADR 0090 §5, PROTOCOL.md §9.6): the one-shot
 * credential that lets the browser's `terminal.attach` WebSocket upgrade
 * authenticate without a long-lived cookie riding the upgrade directly
 * (upgrades bypass SvelteKit's hooks, so cookie-only auth there would skip
 * every other check this deployment makes).
 *
 * 256 random bits, single use, 30s, held in memory only — never at rest,
 * never in Mongo. One replica is assumed (ADR 0089's own assumption, unchanged
 * here): a second replica would need shared storage for tickets to redeem
 * cross-instance, which is out of scope.
 *
 * Bound to `{userId, sessionId, deviceId, terminalId}` at mint time (spec
 * §9.6.1) so a ticket minted for one terminal, session or device can never
 * redeem a WebSocket for another — even though the ticket string itself is
 * unguessable, this closes the case where a ticket leaks (a referrer, a
 * proxy log) and is replayed against a different target the same request
 * could not otherwise reach.
 */
import { randomBytes } from "node:crypto";

const TICKET_TTL_MS = 30_000;

export interface TerminalTicketBinding {
	userId: string;
	sessionId: string;
	deviceId: string;
	terminalId: string;
}

interface StoredTicket extends TerminalTicketBinding {
	expiresAt: number;
}

const tickets = new Map<string, StoredTicket>();

function sweep(now: number): void {
	for (const [ticket, entry] of tickets) {
		if (entry.expiresAt <= now) tickets.delete(ticket);
	}
}

/** Mints a fresh single-use ticket bound to `binding`, valid for 30s. */
export function mintTerminalTicket(binding: TerminalTicketBinding): string {
	const now = Date.now();
	sweep(now);
	const ticket = randomBytes(32).toString("base64url"); // 256 random bits
	tickets.set(ticket, { ...binding, expiresAt: now + TICKET_TTL_MS });
	return ticket;
}

/**
 * Redeems `ticket`: single use (the entry is deleted whether or not it is
 * still valid, so a replay never succeeds twice, even within the 30s
 * window). The ticket itself *is* the upgrade's authorization — a WebSocket
 * upgrade bypasses SvelteKit's hooks, so there is no fresh `locals.user` to
 * compare against here; the bound `{userId, sessionId, deviceId,
 * terminalId}` this returns becomes the connection's principal, exactly as
 * minting it (through the ordinary hooks, `getPairedDevice`, step-up) meant
 * to authorize. `null` for a missing, expired or already-redeemed ticket.
 */
export function redeemTerminalTicket(
	ticket: string,
	now: number = Date.now()
): TerminalTicketBinding | null {
	sweep(now);
	const entry = tickets.get(ticket);
	tickets.delete(ticket);
	if (!entry) return null;
	if (entry.expiresAt <= now) return null;
	const { userId, sessionId, deviceId, terminalId } = entry;
	return { userId, sessionId, deviceId, terminalId };
}

/** Test-only: how many unexpired tickets are currently held, and reset. */
export function _ticketStoreSizeForTests(): number {
	sweep(Date.now());
	return tickets.size;
}

export function _resetTicketStoreForTests(): void {
	tickets.clear();
}
