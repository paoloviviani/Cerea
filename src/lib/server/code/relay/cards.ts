import type { ObjectId } from "mongodb";
import { z } from "zod";
import { logger } from "$lib/server/logger";
import { CallError } from "$lib/server/code/machineCallError";
import { holdAsk, releaseAsk } from "$lib/server/review/wording";
import type { Envelope, PermissionRequest } from "$lib/types/machineProtocol";
import type { RelayCardFacts, RelayCardView } from "$lib/types/CodeRelay";
import { callerFacts, cardFacts, targetFacts } from "./facts";
import { isRelayAsk, setView, viewKey, viewOf, views } from "./views";
import { ticketHash } from "./hash";
import { askCapReason, noteAsk, serializedFor } from "./limits";
import { findTicket, recordTicket } from "./tickets";

/**
 * The relay card (ADR 0121 sections 4 and 5): what a person reads before approving a call to
 * another computer is Cerea's own record, never what the asking galopin wrote.
 *
 * A relay ask is a `permission.asked` whose metadata says `relay: true`. At that moment Cerea
 * holds the ask (it draws as a quiet line, uncounted and unpushed, and the reviewer never sees
 * it), resolves every name itself, writes the ticket and only then releases it: the card, the
 * Needs-you row and the push all render from `relayView`, which reads the record's facts. An ask
 * with no record (metadata dropped, over the cap, the resolve failed) renders as "cannot be
 * approved from here", and nothing can mint a ticket for it: fail closed.
 */

/** What galopin's relay ask must carry. Everything here is what the call will later carry, so the
 * ticket can bind to it; none of it is shown to a person unless Cerea's record repeats it. */
const askMeta = z
	.object({
		relay: z.literal(true),
		op: z.enum(["send", "read", "spawn"]),
		computerId: z.string().regex(/^[0-9a-f]{24}$/),
		sessionId: z.string().min(1).max(256).optional(),
		workspaceId: z.string().min(1).max(256).optional(),
		text: z.string().optional(),
		prompt: z.string().optional(),
		last: z.number().int().min(1).max(50).optional(),
		title: z.string().max(200).optional(),
		mode: z.enum(["plan", "build"]).optional(),
		hop: z.number().int().min(1).max(3),
	})
	.passthrough();

export const MAX_TEXT_BYTES = 8 << 10;

function tooLong(s: string | undefined): boolean {
	return s !== undefined && Buffer.byteLength(s, "utf8") > MAX_TEXT_BYTES;
}

// -- the ask-time record -----------------------------------------------------------------------

/** Why a relay ask cannot be recorded; every one fails closed. */
export class RelayAskRefused extends Error {}

/**
 * Resolve the labels, check the caps and write the ticket for one relay ask. Throws
 * `RelayAskRefused` with a sentence for the card when it cannot.
 */
export async function recordRelayAsk(
	userId: ObjectId,
	deviceId: string,
	request: PermissionRequest
): Promise<RelayCardView> {
	const parsed = askMeta.safeParse(request.metadata ?? {});
	if (!parsed.success) throw new RelayAskRefused("The request's details were not valid.");
	const m = parsed.data;
	const callerSessionId = request.sessionId;
	if (!callerSessionId) throw new RelayAskRefused("The request names no calling session.");
	// The covered fields of each op, and no others.
	let covered: Parameters<typeof cardFacts>[4];
	switch (m.op) {
		case "send":
			if (!m.sessionId || m.text === undefined || !m.text.trim() || tooLong(m.text)) {
				throw new RelayAskRefused("The message was missing or too long.");
			}
			covered = { hop: m.hop, text: m.text };
			break;
		case "read":
			if (!m.sessionId || m.last === undefined) {
				throw new RelayAskRefused("The request did not say what to read.");
			}
			covered = { hop: m.hop, last: m.last };
			break;
		default:
			if (
				!m.workspaceId ||
				m.prompt === undefined ||
				!m.prompt.trim() ||
				tooLong(m.prompt) ||
				!m.title ||
				!m.mode
			) {
				throw new RelayAskRefused(
					"The new session's prompt, title or mode was missing or too long."
				);
			}
			covered = { hop: m.hop, prompt: m.prompt, title: m.title, mode: m.mode };
	}
	return serializedFor(`owner:${userId.toHexString()}`, async () => {
		const cap = await askCapReason(userId, deviceId);
		if (cap) throw new RelayAskRefused(cap);
		let facts: RelayCardFacts;
		try {
			const caller = await callerFacts(userId, deviceId, callerSessionId);
			const target = await targetFacts(userId, {
				op: m.op,
				computerId: m.computerId,
				sessionId: m.sessionId,
				workspaceId: m.workspaceId,
			});
			facts = cardFacts(m.op, caller, caller.sessionTitle, target, covered);
		} catch (err) {
			throw new RelayAskRefused(
				err instanceof CallError ? err.message : "Cerea could not check this request just now."
			);
		}
		const hash = ticketHash({
			op: m.op,
			computerId: m.computerId,
			sessionId: m.sessionId ?? null,
			workspaceId: m.workspaceId ?? null,
			text: covered.text ?? null,
			prompt: covered.prompt ?? null,
			last: covered.last ?? null,
			title: covered.title ?? null,
			mode: covered.mode ?? null,
			hop: m.hop,
			callerSessionId,
		});
		await recordTicket({ userId, deviceId, requestId: request.id, callerSessionId, hash, facts });
		await noteAsk(userId, deviceId);
		return viewOf(facts);
	});
}

/**
 * Load the records of relay asks this process has no view for (a restart, an ask seen first by a
 * snapshot), so a card or an inbox row renders from the record, not as "cannot be approved".
 */
export async function primeRelayCards(
	deviceId: string,
	requests: Array<{ id: string; sessionId?: string; metadata?: Record<string, unknown> }>
): Promise<void> {
	for (const request of requests) {
		if (!isRelayAsk(request) || views.has(viewKey(request))) continue;
		const ticket = await findTicket(deviceId, request.id);
		if (ticket && ticket.callerSessionId === (request.sessionId ?? ticket.callerSessionId)) {
			setView(request, viewOf(ticket.facts));
		}
	}
}

// -- the observer ------------------------------------------------------------------------------

function pushBody(view: RelayCardView): string {
	if (!view.approvable) return "A coding agent's request to another computer is waiting.";
	switch (view.op) {
		case "send":
			return "A coding agent wants to send a message to a session on another computer.";
		case "read":
			return "A coding agent wants to read a session on another computer.";
		default:
			return "A coding agent wants to start a session on another computer.";
	}
}

/**
 * A relay ask arrived: hold it, record it, release it, then push. Called by the push watcher for a
 * paired machine's `permission.asked` with `metadata.relay`, before any reviewer, push or card.
 * The held ask is not counted or shown (its line says it is being checked); on release every open
 * stream re-sends it, now from the record. A refusal still releases it (as "cannot be approved"),
 * and an ask refused by a cap sends no push.
 */
export function observeRelayAsk(
	userId: ObjectId,
	deviceId: string,
	envelope: Envelope,
	send: (body: string) => void
): void {
	const event = envelope.event;
	if (event.kind !== "permission.asked") return;
	const request = event.request;
	holdAsk(request.id, [request.sessionId, envelope.sessionId, envelope.rootSessionId]);
	void (async () => {
		let view: RelayCardView;
		try {
			view = await recordRelayAsk(userId, deviceId, request);
		} catch (err) {
			view = {
				approvable: false,
				reason:
					err instanceof RelayAskRefused
						? err.message
						: "Cerea could not record this request, so it cannot be approved from here.",
			};
			if (!(err instanceof RelayAskRefused)) {
				logger.warn({ err: String(err), requestId: request.id }, "relay: could not record an ask");
			}
		}
		setView(request, view);
		releaseAsk(request.id);
		// A card that cannot be approved needs no one's attention.
		if (view.approvable) send(pushBody(view));
	})();
}
