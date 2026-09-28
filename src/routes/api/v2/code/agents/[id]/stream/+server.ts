/**
 * The agent (session) timeline as server-sent events, translated live from
 * the paired machine — rebuilt on the machine's own `epoch`/`seq` cursor
 * (spec §8): no invented replay counter (R3) and no content-keyed seam
 * de-duplication (R4).
 *
 * The browser holds one `EventSource` on this endpoint; the server holds one
 * subscription to the session's live events (`subscribeSessionEvents`,
 * `machines.ts`) plus one `session.sync` call for history. Sequence:
 * subscribe first (buffering), then `session.sync` with the browser's
 * `Last-Event-ID` (`<epoch>:<seq>`), emit the sync's answer (a snapshot or a
 * replayed run of envelopes), then drain whatever the subscription buffered
 * during that round trip, filtered to `seq > sync.seq` in the same epoch —
 * the seam a fixed cursor makes safe to filter by identity rather than
 * content.
 *
 * SSE `id` is `<epoch>:<seq>` of the envelope a frame came from, so
 * `EventSource` resumes correctly on any reconnect. An epoch change — the
 * machine's process restarted, so its in-memory session state (and this
 * connection's whole cursor) is gone — sends a plain `reset` event; the
 * client (`codeAgentStream.ts`) re-folds the transcript from scratch on it.
 * Listener migration across a machine reconnect (`machines.ts`'s `onHello`)
 * means this same open connection keeps tailing without the browser having
 * to reconnect, so a reset here never needs to close the stream.
 *
 * No per-frame `logger.info` (R6): the old bridge's "trace the SSE bridge"
 * commit left three of them running at token rate, thousands of lines per
 * turn. Only connection-level failures are logged here.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { MachineLink, subscribeSessionTree } from "$lib/server/code/machines";
import { getPairedDevice, requireCodeAgents } from "$lib/server/codeDevices";
import {
	eventToUpdates,
	foldEnvelopeEvents,
	lastAssistantErrorOf,
	permissionRequestToUpdate,
	snapshotToUpdates,
	userMessageIdsOf,
	commandMarkersOf,
	type ChildContext,
} from "$lib/server/code/machineTimeline";
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";
import { OpError, type Envelope } from "$lib/types/machineProtocol";
import { logger } from "$lib/server/logger";
import { codeAttachmentKey } from "$lib/server/codeAttachments";
import { findAttachments } from "$lib/server/files/attachmentStore";
import type { MessageFile } from "$lib/types/Message";

const HEARTBEAT_AFTER_MS = 15_000;
const MAX_LIFETIME_MS = 30 * 60_000;

export const GET: RequestHandler = async ({ params, locals, url, request }) => {
	requireCodeAgents(locals);
	const sessionId = params.id ?? "";
	if (!/^[A-Za-z0-9_.:~-]+$/.test(sessionId)) error(400, "Not a valid agent id.");
	const device = await getPairedDevice(locals, url.searchParams.get("device"));
	const deviceId = device._id.toString();
	const link = new MachineLink(deviceId);

	// Subscribe first and buffer, so events fired while `session.sync` is in
	// flight are queued rather than lost at the seam. The subscription is
	// on the whole session tree (not just this session): a subagent's
	// approval or question must surface in the parent's view mid-turn,
	// which a parent-id-only subscription would drop.
	const buffered: Envelope[] = [];
	let wake: (() => void) | null = null;
	const notify = () => {
		wake?.();
		wake = null;
	};
	const unsubscribe = subscribeSessionTree(deviceId, sessionId, (envelope) => {
		buffered.push(envelope);
		notify();
	});

	// A subagent's title for its cards' "Subagent ‹title›" label — the
	// roster when it answers, a `session` event when one names it, else
	// the bare "Subagent:" fallback the fold applies.
	const childTitles = new Map<string, string | null>();
	const childOf = (id: string): ChildContext | undefined =>
		id === sessionId ? undefined : { childId: id, childTitle: childTitles.get(id) ?? null };
	const learnTitle = (envelope: Envelope) => {
		if (
			envelope.sessionId !== sessionId &&
			envelope.event.kind === "session" &&
			typeof envelope.event.session.title === "string"
		) {
			childTitles.set(envelope.sessionId, envelope.event.session.title);
		}
	};
	try {
		const { sessions } = await link.sessionChildren({ sessionId });
		for (const child of sessions) childTitles.set(child.id, child.title);
	} catch {
		// The roster is a label nicety, not the stream: without it the
		// cards still arrive, just under the untitled fallback.
	}

	const lastEventId = request.headers.get("last-event-id");
	let clientEpoch: string | undefined;
	let clientSeq: number | undefined;
	if (lastEventId) {
		const sep = lastEventId.indexOf(":");
		if (sep > 0) {
			clientEpoch = lastEventId.slice(0, sep);
			clientSeq = Number.parseInt(lastEventId.slice(sep + 1), 10);
		}
	}

	let sync;
	try {
		sync = await link.sessionSync({
			sessionId,
			...(clientEpoch ? { epoch: clientEpoch, afterSeq: clientSeq } : {}),
		});
	} catch (err) {
		unsubscribe();
		// `unavailable` is the routine "this machine is not connected right
		// now" case (R1): `EventSource` reconnects on its own timer, so an
		// offline machine would otherwise warn-log on every single retry for
		// as long as it stays offline. Anything else is unexpected and stays
		// at `warn`.
		if (!(err instanceof OpError) || err.code !== "unavailable") {
			logger.warn({ err, deviceId, sessionId }, "agent stream: session.sync failed");
		}
		error(502, "The paired machine could not be reached.");
	}

	const epochChangedAtOpen = clientEpoch !== undefined && clientEpoch !== sync.epoch;
	let initial: AgentStreamUpdate[];
	let lastAssistantError: string | undefined;
	let userMessageIds: Map<string, string>;
	// The command markers ride the same tracking: seeded from the snapshot,
	// learned live, resolved per part (PROTOCOL.md §7).
	let commandMarkers: Map<string, { name: string; arguments: string }>;
	if ("snapshot" in sync) {
		initial = snapshotToUpdates(sync.snapshot);
		lastAssistantError = lastAssistantErrorOf(sync.snapshot);
		userMessageIds = userMessageIdsOf(sync.snapshot);
		commandMarkers = commandMarkersOf(sync.snapshot);
	} else {
		const folded = foldEnvelopeEvents(sync.events);
		initial = folded.updates;
		lastAssistantError = folded.lastAssistantError;
		userMessageIds = folded.userMessageIds;
		commandMarkers = folded.commandMarkers;
	}

	// Seed the cards for approvals already waiting on a subagent: opening
	// the view mid-turn (or re-opening it after an SSE reconnect, whose
	// cursor only covers the parent) must show the same card the live tail
	// would have carried. Questions have no snapshot field, so only
	// permissions seed here — a waiting question re-announces on the
	// child's next event.
	const seenChildAsks = new Set<string>();
	for (const [childId, title] of childTitles) {
		try {
			const childSync = await link.sessionSync({ sessionId: childId });
			if (!("snapshot" in childSync)) continue;
			for (const permission of childSync.snapshot.permissions ?? []) {
				if (seenChildAsks.has(permission.id)) continue;
				seenChildAsks.add(permission.id);
				initial.push(permissionRequestToUpdate(permission, { childId, childTitle: title }));
			}
		} catch {
			// One child's history failing to load must not fail the parent's
			// stream — the live tail still carries whatever it asks next.
		}
	}

	// An ask the seed already turned into a card must not fold a second
	// time when its live envelope drains below: the ask was emitted before
	// this subscription started, but it is still pending, so the child's
	// own sync (taken above) and the buffered live tail can both name it.
	const askIdOf = (envelope: Envelope): string | null => {
		if (envelope.sessionId === sessionId) return null;
		const event = envelope.event;
		if (event.kind === "permission.asked") return event.request.id;
		if (event.kind === "question.asked") return event.request.id;
		return null;
	};
	const dedupeSeeded = (envelopes: Envelope[]): Envelope[] =>
		envelopes.filter((envelope) => {
			const id = askIdOf(envelope);
			if (id === null) return true;
			if (seenChildAsks.has(id)) return false;
			seenChildAsks.add(id);
			return true;
		});

	// Drain the buffer: only what arrived strictly after the sync's own
	// cursor, in the same epoch — anything ≤ sync.seq is already covered by
	// `initial`, and a different epoch here means the machine has already
	// moved on again since the sync answered (rare, handled below like any
	// other mid-stream epoch change). The sync's cursor is the parent
	// session's own: a child's envelope is ordered on the child's own
	// sequence, so every same-epoch child envelope buffered here is new.
	const drainedNow = buffered
		.splice(0)
		.filter((e) =>
			e.sessionId === sessionId
				? e.epoch === sync.epoch && e.seq > sync.seq
				: e.epoch === sync.epoch
		);
	for (const envelope of drainedNow) learnTitle(envelope);
	const drainedFolded = foldEnvelopeEvents(
		dedupeSeeded(drainedNow),
		lastAssistantError,
		userMessageIds,
		childOf,
		commandMarkers
	);
	lastAssistantError = drainedFolded.lastAssistantError;
	userMessageIds = drainedFolded.userMessageIds;
	commandMarkers = drainedFolded.commandMarkers;

	// A user frame carries its clientMessageId; the files uploaded under that id
	// (the attachment store) ride on the frame so the transcript renders them,
	// after a reload as much as live. Looked up once per message.
	const ownerKey = codeAttachmentKey(deviceId, sessionId);
	const filesByMessage = new Map<string, Promise<MessageFile[]>>();
	const withFiles = async (update: AgentStreamUpdate): Promise<AgentStreamUpdate> => {
		if (update.type !== "user" || !update.messageId) return update;
		let files = filesByMessage.get(update.messageId);
		if (!files) {
			files = findAttachments(ownerKey, update.messageId).catch(() => []);
			filesByMessage.set(update.messageId, files);
		}
		const found = await files;
		return found.length ? { ...update, files: found } : update;
	};

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const signal = request.signal;
			let closed = false;
			let lastEmit = Date.now();
			let currentEpoch = sync.epoch;
			const enc = (s: string) => controller.enqueue(encoder.encode(s));
			// `id` is the watched session's own (epoch, seq) cursor, which the
			// client echoes back as Last-Event-ID to resume. A subagent's
			// frames are ordered on the subagent's sequence, not this one, so
			// they go out with no id: an SSE event without one leaves the
			// client's last event id where the parent's last frame put it.
			const emit = (id: string | null, update: AgentStreamUpdate) => {
				const idLine = id === null ? "" : `id: ${id}\n`;
				enc(`${idLine}event: update\ndata: ${JSON.stringify(update)}\n\n`);
				lastEmit = Date.now();
			};
			// A reset travels the ordinary `update` channel (a frame the
			// client already knows how to route to `consumeAgentUpdates`'s
			// fold), not a distinct SSE event type — one fewer thing the
			// client has to know how to parse.
			const emitReset = (id: string) => emit(id, { type: "reset" });

			const finish = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				clearTimeout(lifetime);
				signal.removeEventListener("abort", onAbort);
				unsubscribe();
				notify();
				try {
					controller.close();
				} catch {
					// already closed
				}
			};
			const onAbort = () => finish();
			signal.addEventListener("abort", onAbort, { once: true });
			const lifetime = setTimeout(finish, MAX_LIFETIME_MS);
			const heartbeat = setInterval(() => {
				if (closed) return;
				if (Date.now() - lastEmit >= HEARTBEAT_AFTER_MS) {
					try {
						enc(": heartbeat\n\n");
						lastEmit = Date.now();
					} catch {
						finish();
					}
				}
			}, 1000);

			try {
				const openId = `${sync.epoch}:${sync.seq}`;
				if (epochChangedAtOpen) emitReset(openId);
				for (const update of initial) {
					if (closed) return;
					emit(openId, await withFiles(update));
				}
				for (const update of drainedFolded.updates) {
					if (closed) return;
					emit(openId, await withFiles(update));
				}
				// Live tail: every subsequent envelope gets its own id. An
				// epoch change here means the machine's process restarted —
				// its session state (and every seq before this point) is
				// gone — so the client re-folds from scratch, but the
				// connection itself stays open (listener migration in
				// `machines.ts` means a reconnected machine keeps pushing
				// through this same subscription).
				for (;;) {
					if (closed) return;
					const next = buffered.shift();
					if (next !== undefined) {
						const id = `${next.epoch}:${next.seq}`;
						if (next.epoch !== currentEpoch) {
							currentEpoch = next.epoch;
							// A fresh epoch's message/session ids are unrelated to the
							// old one's — carrying either tracked value over could
							// mislabel the new epoch's own first frames.
							lastAssistantError = undefined;
							userMessageIds = new Map();
							commandMarkers = new Map();
							seenChildAsks.clear();
							// A subagent's envelope can be the first to show the new
							// epoch; its seq is not this session's cursor.
							emit(next.sessionId === sessionId ? id : null, { type: "reset" });
						}
						learnTitle(next);
						const child = childOf(next.sessionId);
						if (!child && next.event.kind === "message") {
							if (next.event.message.role === "assistant") {
								lastAssistantError = next.event.message.error;
							} else if (next.event.message.clientMessageId) {
								userMessageIds.set(next.event.message.id, next.event.message.clientMessageId);
							}
							if (next.event.message.role === "user" && next.event.message.command) {
								commandMarkers.set(next.event.message.id, next.event.message.command);
							}
						}
						// A re-announced ask this connection already carded
						// folds once — its resolutions still flow, only the
						// duplicate request is dropped.
						if (dedupeSeeded([next]).length === 0) continue;
						const updates = eventToUpdates(
							next.event,
							lastAssistantError,
							(messageId) => userMessageIds.get(messageId),
							child,
							(messageId) => commandMarkers.get(messageId)
						);
						for (const update of updates) emit(child ? null : id, await withFiles(update));
						continue;
					}
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
			} catch (err) {
				logger.warn({ err, deviceId, sessionId }, "agent stream: bridge ended");
			}
			finish();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
};
