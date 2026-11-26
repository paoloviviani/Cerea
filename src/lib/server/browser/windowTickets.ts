/**
 * Connect tickets for the window browser socket (ADR 0122), the same idea as the terminal's
 * (`code/terminalTickets.ts`): a WebSocket upgrade never passes through the app's hooks, so the
 * credential is minted by an ordinary request (session, CSRF and content-type rules apply there)
 * and redeemed once, within 30 seconds, by the upgrade. 256 random bits, in memory only, bound to
 * the user, the session and the window id it was minted for.
 */
import { randomBytes } from "node:crypto";

const TICKET_TTL_MS = 30_000;

export interface WindowTicketBinding {
	userId: string;
	sessionId: string;
	windowId: string;
	/** The window's grant key, derived from the session secret when the ticket was minted. */
	key: Buffer;
}

const tickets = new Map<string, WindowTicketBinding & { expiresAt: number }>();

function sweep(now: number): void {
	for (const [ticket, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(ticket);
}

export function mintWindowTicket(binding: WindowTicketBinding): string {
	const now = Date.now();
	sweep(now);
	const ticket = randomBytes(32).toString("base64url");
	tickets.set(ticket, { ...binding, expiresAt: now + TICKET_TTL_MS });
	return ticket;
}

/** Single use: the entry goes whether or not it was still valid. */
export function redeemWindowTicket(ticket: string, now = Date.now()): WindowTicketBinding | null {
	const entry = tickets.get(ticket);
	tickets.delete(ticket);
	if (!entry || entry.expiresAt <= now) return null;
	const { expiresAt: _expiresAt, ...binding } = entry;
	void _expiresAt;
	return binding;
}
