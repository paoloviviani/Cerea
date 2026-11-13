/**
 * The live view of a running browse task (ADR 0116 phase 2a): a Server-Sent Events stream of the
 * browser's frames, for the chat's owner only. It reuses the app's own realtime channel (SSE, as
 * the generation and sidebar feeds do) rather than a socket of its own.
 *
 *   event: frame    data: {seq, w, h, data}   one JPEG (base64), w x h is the page's viewport
 *   event: session  data: {id, machineId, machineName, kind, url, origin, controller, unattended}
 *                   what this is of and where it runs; sent first and again when the page changes
 *   event: control  data: {controller}        "agent" | "user": who has the page
 *   event: end      data: {reason}            the task ended or lost its machine; do not reconnect
 *
 * `?width=` is the width the viewer can show (a small card, a full screen). A task that is not
 * running, or is not the caller's, is a 404 the same. Nothing is stored and no frame is logged.
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { liveTaskFor, type LiveEvent, type LiveViewer } from "$lib/server/browser/liveView";

const MAX_LIFETIME_MS = 10 * 60_000;
const PING_MS = 15_000;
/** The most bytes waiting for a slow connection before frames are dropped instead. */
const BACKLOG_BYTES = 1_000_000;

export const GET: RequestHandler = async ({ locals, params, url, request }) => {
	if (!locals.user) error(401, "Unauthorized");
	const task = liveTaskFor(params.uuid ?? "", locals.user._id.toString());
	if (!task) error(404, "No such running browser task");
	if (!task.supported) error(501, "The browser on that computer is too old for the live view");
	if (!task.hasRoom) error(429, "Too many viewers on this browser");

	const width = Number(url.searchParams.get("width"));
	const encoder = new TextEncoder();
	let cleanup: (() => void) | undefined;

	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				/** `droppable` (frames): never queued while the connection is backed up. */
				const write = (text: string, droppable = false): boolean => {
					try {
						if (droppable && (controller.desiredSize ?? 0) <= 0) return false;
						controller.enqueue(encoder.encode(text));
						return (controller.desiredSize ?? 0) > 0;
					} catch {
						return false;
					}
				};
				const viewer: LiveViewer = {
					width: Number.isFinite(width) && width > 0 ? width : 640,
					send(event: LiveEvent) {
						if (event.type === "frame") {
							return write(
								`event: frame\ndata: ${JSON.stringify({
									seq: event.seq,
									w: event.width,
									h: event.height,
									data: event.jpeg.toString("base64"),
								})}\n\n`,
								true
							);
						}
						if (event.type === "session") {
							return write(`event: session\ndata: ${JSON.stringify(event.info)}\n\n`);
						}
						if (event.type === "control") {
							return write(
								`event: control\ndata: ${JSON.stringify({ controller: event.controller })}\n\n`
							);
						}
						const sent = write(`event: end\ndata: ${JSON.stringify({ reason: event.reason })}\n\n`);
						queueMicrotask(close);
						return sent;
					},
				};
				const remove = task.addViewer(viewer);
				if (!remove) {
					controller.close();
					return;
				}
				const leave = remove;
				const ping = setInterval(() => write(": ping\n\n"), PING_MS);
				const lifetime = setTimeout(() => close(), MAX_LIFETIME_MS);
				let closed = false;
				function close() {
					if (closed) return;
					closed = true;
					clearInterval(ping);
					clearTimeout(lifetime);
					leave();
					try {
						controller.close();
					} catch {
						// already closed by the client
					}
				}
				cleanup = close;
				request.signal.addEventListener("abort", close, { once: true });
			},
			cancel() {
				cleanup?.();
			},
		},
		new ByteLengthQueuingStrategy({ highWaterMark: BACKLOG_BYTES })
	);

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-store, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		},
	});
};
