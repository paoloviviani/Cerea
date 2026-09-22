/**
 * The agent timeline as server-sent events, translated live from the daemon.
 *
 * The browser holds one `EventSource` on this endpoint; the server holds the
 * one subscription to the daemon — through the caller's relay link
 * (`codeDaemon.ts`), never a browser-reachable URL. Frames are translated,
 * not relayed: daemon timeline items and stream events go through
 * `codeTimeline.ts` into the chat's update shapes, and anything without a
 * panel representation is dropped rather than invented into one.
 *
 * History then live: the daemon's timeline is fetched (a bounded tail) and
 * mapped first; the subscription — opened before the fetch, buffering — is
 * drained afterwards, with frames the history already delivered dropped by
 * their stable keys. The seam between the two sources therefore cannot
 * double-render a frame in either direction. Tool keys carry the status on
 * purpose: history holds the call as it stood at fetch time, and the live
 * completion that lands in the buffer must survive the seam instead of being
 * keyed away by the stale entry. The agent's own status joins as a synthetic
 * turn state, so a mount mid-run renders live without waiting for a turn
 * event that has already fired.
 *
 * SSE: `event: update` carries one `AgentStreamUpdate`, tagged `id: <seq>` so
 * EventSource resumes via Last-Event-ID on reconnect. The seq counts a
 * deterministic replay (the daemon's timeline is the same list on every
 * fetch), so a resumed connection skips exactly the frames the browser
 * already has and continues the count from there; frames the old connection
 * saw live but that history has not absorbed yet are re-derived — permission
 * requests come from the agent's snapshot, which is upsert-safe in the
 * transcript, and turn-state markers are cosmetic. `event: end` never fires
 * from here: the bridge's lifetime cap and aborts close the stream plainly,
 * which is the client's reconnect signal.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { linkForDevice } from "$lib/server/codeDaemon";
import {
	agentStatusTurnState,
	permissionRequestToUpdate,
	streamEventToUpdate,
	timelineEntryToUpdate,
} from "$lib/server/codeTimeline";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { MessageElicitationUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";
import { logger } from "$lib/server/logger";

const MAX_LIFETIME_MS = 5 * 60_000;
const HEARTBEAT_AFTER_MS = 15_000;

/** A frame's identity for seam de-duplication: the same item never twice. */
function frameKey(update: AgentStreamUpdate): string | null {
	switch (update.type) {
		case "user":
			return `u:${update.text}`;
		case MessageUpdateType.Stream:
			return `s:${update.token}`;
		case MessageUpdateType.Tool:
			return `t:${update.uuid}:${update.subtype}`;
		case MessageUpdateType.Plan:
			return `p:${update.goal}:${update.steps.map((step) => `${step.step}:${step.status}`).join("|")}`;
		case MessageUpdateType.Elicitation:
			return update.subtype === MessageElicitationUpdateType.Request
				? `q:${update.request.elicitationId}`
				: `r:${update.elicitationId}`;
		default:
			// Turn states are cosmetic re-convergences, never de-duplicated.
			return null;
	}
}

export const GET: RequestHandler = async ({ params, locals, url, request }) => {
	requireCodeAgents(locals);
	const agentId = params.id ?? "";
	if (!/^[A-Za-z0-9_.:~-]+$/.test(agentId)) error(400, "Not a valid agent id.");
	const link = await linkForDevice(locals, url.searchParams.get("device"));
	const client = await link.ensureReady();

	// Subscribe first and buffer, so events fired while history is being
	// fetched are queued rather than lost at the seam.
	const buffered: AgentStreamUpdate[] = [];
	let wake: (() => void) | null = null;
	const notify = () => {
		wake?.();
		wake = null;
	};
	const unsubscribe = client.subscribeAgentTimeline(agentId, (message) => {
		if (message.type !== "agent_stream") return;
		const event = (message as { event?: unknown }).event;
		if (!event) return;
		try {
			const updates = streamEventToUpdate(event as Parameters<typeof streamEventToUpdate>[0]);
			if (updates.length) {
				buffered.push(...updates);
				notify();
			}
		} catch (err) {
			logger.warn({ err, agentId }, "dropping an unmappable agent stream event");
		}
	});

	const agent = await client.fetchAgent(agentId).catch(() => null);
	if (!agent) {
		unsubscribe();
		error(404, "No such agent on this daemon.");
	}

	let history: AgentStreamUpdate[] = [];
	try {
		const timeline = await link.fetchTimeline(agentId);
		history = timeline.entries.flatMap(timelineEntryToUpdate);
	} catch (err) {
		logger.warn({ err, agentId }, "timeline history fetch failed; streaming live only");
	}

	// Drain the buffer, dropping what history already delivered.
	const seen = new Set<string>();
	for (const update of history) {
		const key = frameKey(update);
		if (key) seen.add(key);
	}
	const drained: AgentStreamUpdate[] = [];
	for (const update of buffered) {
		const key = frameKey(update);
		if (key && seen.has(key)) continue;
		if (key) seen.add(key);
		drained.push(update);
	}
	buffered.length = 0;

	// Permissions live outside the timeline: surface whatever is still
	// pending so a fresh mount shows the blocking card. A request the
	// subscription already delivered is skipped here, not rendered twice —
	// the transcript's approval card is keyed by request id and the fold
	// does not upsert request blocks. A replayed resolution overtakes them
	// safely.
	const pending = (agent.agent.pendingPermissions ?? [])
		.map(permissionRequestToUpdate)
		.filter((update) => {
			const key = frameKey(update);
			if (key && seen.has(key)) return false;
			if (key) seen.add(key);
			return true;
		});

	const statusFrame = agentStatusTurnState(agent.agent.status);
	const initial: AgentStreamUpdate[] = [
		...history,
		...(statusFrame ? [statusFrame] : []),
		...drained,
		...pending,
	];

	const lastEventId = request.headers.get("last-event-id");
	const resumeFrom =
		Number.parseInt(lastEventId ?? url.searchParams.get("fromSeq") ?? "0", 10) || 0;

	const encoder = new TextEncoder();
	let seq = 0;

	const stream = new ReadableStream({
		async start(controller) {
			const signal = request.signal;
			let closed = false;
			let lastEmit = Date.now();
			const enc = (s: string) => controller.enqueue(encoder.encode(s));
			const emit = (update: AgentStreamUpdate) => {
				seq += 1;
				enc(`id: ${seq}\nevent: update\ndata: ${JSON.stringify(update)}\n\n`);
				lastEmit = Date.now();
			};

			// Idempotent teardown, called exactly once per connection no
			// matter which of abort, deadline or error wins the race.
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
			// The 5-minute cap as an exact timer rather than a per-tick
			// check: a silent daemon holds the pump below forever, and a
			// check that only runs when data flows would never fire.
			const lifetime = setTimeout(finish, MAX_LIFETIME_MS);
			// The heartbeat is a separate timer, not a race against the
			// pump: it fires only when the line has been quiet for
			// HEARTBEAT_AFTER_MS, and writes reset `lastEmit`.
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
				for (const update of initial) {
					if (closed) return;
					// Deterministic replay: the browser has everything up to
					// its last event id, so skip exactly that prefix.
					if (seq + 1 > resumeFrom) emit(update);
					else seq += 1;
				}
				// From here the subscription is the only source: every
				// mapped frame continues the same count.
				for (;;) {
					if (closed) return;
					const next = buffered.shift();
					if (next !== undefined) {
						emit(next);
						continue;
					}
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
			} catch (err) {
				// Transient — fall through to a plain close so the client
				// reconnects with its Last-Event-ID.
				logger.warn({ err, agentId }, "agent timeline bridge ended");
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
