/**
 * The agent timeline as server-sent events, re-emitted from the daemon.
 *
 * The browser holds one `EventSource` on this endpoint; the server holds the
 * one subscription to the daemon (`GET {daemon}/v1/agents/{id}/timeline/stream`)
 * the forwarder deliberately does not offer the browser. Frames are
 * re-emitted, not relayed byte-for-byte: each `update` frame's data must
 * parse as JSON with a known agent-update `type`, or it is dropped rather
 * than forwarded — a malformed frame must not tear down the transcript.
 *
 * SSE: `event: update` carries one `CodeAgentUpdate`, tagged `id: <seq>` so
 * EventSource resumes via Last-Event-ID on reconnect; `event: end {status}`
 * is terminal and the client closes; a plain close (lifetime cap, transient)
 * means reconnect. A fresh mount connects with `fromSeq=0`, and the daemon
 * replays its log before tailing — so no separate history fetch is needed,
 * and reload is lossless by construction.
 *
 * Coded against the daemon shape `id: <seq> / event: update|end / data: {...}`
 * with `: heartbeat` comments; a daemon that never heartbeats gets ours when
 * the line has been quiet for 15s. No live daemon was available to verify
 * against — see the panel summary for exactly what needs one.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { daemonBaseUrl, daemonHeaders, PASEO_API_VERSION } from "$lib/server/codeDaemon";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { CodeAgentUpdateType } from "$lib/types/CodeAgent";
import { logger } from "$lib/server/logger";

const ID_PATTERN = /^[A-Za-z0-9_.:~-]+$/;
const MAX_LIFETIME_MS = 5 * 60_000;
const HEARTBEAT_AFTER_MS = 15_000;

const KNOWN_TYPES = new Set<string>(Object.values(CodeAgentUpdateType));

interface ParsedFrame {
	id?: string;
	event: string;
	data: string;
}

/** Split a buffered SSE byte-chunk into complete frames, keeping the remainder. */
function splitFrames(buffer: string): { frames: ParsedFrame[]; rest: string } {
	const frames: ParsedFrame[] = [];
	const parts = buffer.split("\n\n");
	const rest = parts.pop() ?? "";
	for (const part of parts) {
		const lines = part.split("\n");
		let id: string | undefined;
		let event = "message";
		const data: string[] = [];
		for (const line of lines) {
			if (line.startsWith(":")) continue;
			if (line.startsWith("id:")) id = line.slice(3).trim();
			else if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
		}
		if (data.length > 0) frames.push({ id, event, data: data.join("\n") });
	}
	return { frames, rest };
}

function isAgentUpdate(data: string): boolean {
	try {
		const parsed = JSON.parse(data) as { type?: unknown };
		return typeof parsed.type === "string" && KNOWN_TYPES.has(parsed.type);
	} catch {
		return false;
	}
}

export const GET: RequestHandler = async ({ params, locals, url, request }) => {
	requireCodeAgents(locals);
	const agentId = params.id ?? "";
	if (!ID_PATTERN.test(agentId)) error(400, "Not a valid agent id.");

	const lastEventId = request.headers.get("last-event-id");
	const fromSeq = lastEventId ?? url.searchParams.get("fromSeq") ?? "0";

	const daemonUrl =
		`${daemonBaseUrl()}/v1/agents/${encodeURIComponent(agentId)}` +
		`/timeline/stream?fromSeq=${encodeURIComponent(fromSeq)}`;

	let upstream: Response;
	try {
		upstream = await fetch(daemonUrl, { headers: daemonHeaders(), signal: request.signal });
	} catch (err) {
		logger.error({ err, agentId }, "paseo daemon stream could not be opened");
		error(502, "The coding-agent daemon could not be reached.");
	}
	if (!upstream.ok || !upstream.body) {
		const status = upstream.status;
		logger.error({ agentId, status }, "paseo daemon stream refused");
		error(502, "The coding-agent daemon refused the timeline subscription.");
	}
	const advertised = upstream.headers.get("x-paseo-version");
	if (advertised && advertised !== PASEO_API_VERSION) {
		logger.error({ agentId, advertised }, "paseo daemon version mismatch");
		error(502, "The coding-agent daemon speaks an unsupported API version.");
	}

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const reader = upstream.body.getReader();
	let seq = 0;

	const stream = new ReadableStream({
		async start(controller) {
			const signal = request.signal;
			let buffer = "";
			let lastEmit = Date.now();
			let closed = false;
			const enc = (s: string) => controller.enqueue(encoder.encode(s));

			// Idempotent teardown, called exactly once per connection no
			// matter which of abort, deadline, `end` or error wins the race.
			const finish = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				clearTimeout(lifetime);
				signal.removeEventListener("abort", onAbort);
				// A cancelled reader resolves its pending read as done, so
				// the loop below always wakes up to exit — no dangling read.
				void reader.cancel().catch(() => {
					// already closed
				});
				try {
					controller.close();
				} catch {
					// already closed
				}
			};
			const onAbort = () => finish();
			// Registered once, not per tick: the read loop below awaits one
			// `reader.read()` at a time and is never raced against a timer,
			// so neither pending reads nor abort listeners can accumulate
			// while the daemon is quiet.
			signal.addEventListener("abort", onAbort, { once: true });
			// The 5-minute cap as an exact timer rather than a per-tick
			// check: a silent daemon holds the read below forever, and a
			// check that only runs when data flows would never fire.
			const lifetime = setTimeout(finish, MAX_LIFETIME_MS);

			// The heartbeat is a separate timer, not a race against the read:
			// it fires only when the line has been quiet for
			// HEARTBEAT_AFTER_MS, and data writes reset `lastEmit`, so the
			// two never emit back-to-back. Single-threaded writes through one
			// controller cannot interleave mid-frame.
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
				for (;;) {
					if (signal.aborted || closed) break;
					const { done, value } = await reader.read();
					if (done || closed) break;
					buffer += decoder.decode(value, { stream: true });
					const { frames, rest } = splitFrames(buffer);
					buffer = rest;
					for (const frame of frames) {
						if (frame.event === "end") {
							enc(`event: end\ndata: ${frame.data}\n\n`);
							finish();
							return;
						}
						if (frame.event !== "update") continue;
						if (!isAgentUpdate(frame.data)) {
							logger.warn({ agentId }, "dropping a malformed agent timeline frame");
							continue;
						}
						seq += 1;
						enc(`id: ${frame.id ?? seq}\nevent: update\ndata: ${frame.data}\n\n`);
						lastEmit = Date.now();
					}
				}
			} catch {
				// Transient — fall through to a plain close so the client
				// reconnects with its Last-Event-ID.
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
