/**
 * The browser-facing terminal WebSocket (ADR 0090 §5, PROTOCOL.md §9.6):
 * `${base}/api/v2/code/terminal?ticket=…`. Like the machine link
 * (`machineServer.ts`), this is a raw `http.Server` upgrade below
 * SvelteKit's routing — hooks, hence hooks-based auth, never run on it — so
 * every check here is deliberately self-contained: the `Origin` header
 * before anything else, then the ticket (single use, 30s, bound at mint
 * time to `{userId, sessionId, deviceId, terminalId}` — see
 * `terminalTickets.ts`), then a fresh session/device check, repeated every
 * 60s on the open socket.
 *
 * One relay session = one browser tab's view of one terminal. It owns:
 * - the machine-side attach/re-attach cycle (a fresh viewer channel each
 *   time, since a machine-link reconnect may be a different galopin
 *   process instance with no memory of the old channel);
 * - binary relay in both directions (term.input/term.ack from the browser,
 *   term.output to it), reusing the exact wire codec the machine link uses
 *   so there is exactly one implementation of the framing in this process;
 * - the JSON control vocabulary (`resize` in, `reset`/`exit`/
 *   `machine-offline`/`machine-online` out);
 * - liveness (a 20s ping) and re-authorization (a 60s session/device
 *   check, closing 4403 on logout, revoke or unpair).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { ObjectId } from "mongodb";
import { base } from "$app/paths";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { recordCodeAuditRow } from "$lib/server/code/audit";
import { redeemTerminalTicket, type TerminalTicketBinding } from "$lib/server/code/terminalTickets";
import {
	MachineLink,
	registerTerminalChannel,
	sendTerminalInput,
	sendTerminalAck,
	subscribeDeviceConnection,
	subscribeTerminalNotices,
} from "$lib/server/code/machines";
import {
	TERMINAL_PATH,
	OpError,
	decodeBinaryFrame,
	encodeBinaryFrame,
	BIN_TERM_OUTPUT,
	BIN_TERM_INPUT,
	BIN_TERM_ACK,
	MAX_INPUT_FRAME_PAYLOAD,
} from "$lib/types/machineProtocol";

const PING_INTERVAL_MS = 20_000;
const PONG_DEAD_AFTER_MS = 60_000;
const RECHECK_INTERVAL_MS = 60_000;
/** A single fixed placeholder on this leg of the relay: the browser only
 * ever sees one terminal per socket, so the real per-viewer channel id
 * (chosen fresh on every machine attach/re-attach) never needs to reach it. */
const BROWSER_CHANNEL = "b";

function writeHttpRejection(socket: Duplex, status: number, message: string): void {
	const body = message;
	socket.write(
		`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Request"}\r\n` +
			"Connection: close\r\n" +
			"Content-Type: text/plain\r\n" +
			`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
	);
	socket.destroy();
}

/** The one origin this deployment answers as, from `PUBLIC_ORIGIN`. `null`
 * when unset or unparsable — deliberately refuses every connection rather
 * than silently skipping the CSWSH check, since there is no safe default
 * origin to compare against. */
function expectedOrigin(): string | null {
	if (!config.PUBLIC_ORIGIN) return null;
	try {
		return new URL(config.PUBLIC_ORIGIN).origin;
	} catch {
		return null;
	}
}

interface Authorization {
	ok: true;
	userId: ObjectId;
	deviceId: ObjectId;
}
interface AuthorizationFailure {
	ok: false;
	message: string;
}

/** The re-check both the initial upgrade and the 60s loop run: the Cerea
 * session still exists (not logged out) and the device is still this
 * user's own paired row (not revoked, not unpaired). */
async function checkAuthorized(
	binding: Pick<TerminalTicketBinding, "userId" | "sessionId" | "deviceId">
): Promise<Authorization | AuthorizationFailure> {
	const session = await collections.sessions.findOne({ sessionId: binding.sessionId });
	if (!session) return { ok: false, message: "signed out" };
	let userId: ObjectId;
	let deviceId: ObjectId;
	try {
		userId = new ObjectId(binding.userId);
		deviceId = new ObjectId(binding.deviceId);
	} catch {
		return { ok: false, message: "malformed id" };
	}
	if (!session.userId.equals(userId)) return { ok: false, message: "session/user mismatch" };
	const device = await collections.codeDevices.findOne({ _id: deviceId, userId });
	if (!device || device.status !== "paired") return { ok: false, message: "device not paired" };
	return { ok: true, userId, deviceId };
}

const wss = new WebSocketServer({ noServer: true });

export async function handleTerminalUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://internal");
	if (url.pathname !== `${base}${TERMINAL_PATH}`) {
		socket.destroy();
		return;
	}

	// CSWSH (ADR 0090 §5, PROTOCOL.md §9.6): refused before the ticket is
	// even looked at, so a foreign origin never gets to spend it.
	const expected = expectedOrigin();
	const origin = req.headers.origin;
	if (!expected || origin !== expected) {
		logger.warn({ origin }, "terminal ws: origin refused");
		writeHttpRejection(socket, 403, "Origin not allowed.");
		return;
	}

	const ticket = url.searchParams.get("ticket");
	if (!ticket) {
		writeHttpRejection(socket, 401, "A ticket is required.");
		return;
	}
	const binding = redeemTerminalTicket(ticket);
	if (!binding) {
		logger.warn("terminal ws: ticket redeem failed (missing, expired or already used)");
		writeHttpRejection(socket, 401, "Invalid or expired ticket.");
		return;
	}

	const authorized = await checkAuthorized(binding);
	if (!authorized.ok) {
		await recordCodeAuditRow(new ObjectId(binding.userId), {
			action: "terminal.refused",
			deviceId: binding.deviceId,
			terminalId: binding.terminalId,
		});
		writeHttpRejection(socket, 403, "Not authorized for this device.");
		return;
	}

	const fromParam = url.searchParams.get("from");
	const initialFrom =
		fromParam !== null && /^\d+$/.test(fromParam) && Number(fromParam) <= Number.MAX_SAFE_INTEGER
			? Number(fromParam)
			: undefined;

	wss.handleUpgrade(req, socket, head, (client) => {
		acceptTerminalConnection(client, binding, initialFrom);
	});
}

function acceptTerminalConnection(
	ws: WebSocket,
	binding: TerminalTicketBinding,
	initialFrom: number | undefined
): void {
	const { sessionId, deviceId, terminalId } = binding;
	const userObjectId = new ObjectId(binding.userId);
	const link = new MachineLink(deviceId);
	let closed = false;
	let currentChannel: string | null = null;
	let teardownAttach: (() => void) | null = null;
	let lastOffset = 0;
	let lastPongAt = Date.now();

	function send(payload: Buffer): void {
		if (ws.readyState !== ws.OPEN) return;
		try {
			ws.send(payload);
		} catch {
			/* socket already going away */
		}
	}

	function sendJson(payload: unknown): void {
		if (ws.readyState !== ws.OPEN) return;
		try {
			ws.send(JSON.stringify(payload));
		} catch {
			/* socket already going away */
		}
	}

	function audit(action: string): void {
		void recordCodeAuditRow(userObjectId, { action, deviceId, terminalId });
	}

	async function attachToMachine(from: number | undefined): Promise<void> {
		teardownAttach?.();
		teardownAttach = null;
		currentChannel = null;
		const channel = randomUUID().replace(/-/g, "");
		// Registered before the op is even sent: existing ring content is
		// delivered asynchronously as ordinary term.output frames right after
		// the machine answers attach (PROTOCOL.md §9.3), and control frames
		// (this op's own `res`) always precede stream frames on the wire
		// (§9.2's two-lane scheduler) — but there is no reason to depend on
		// that ordering surviving a future change when registering first
		// costs nothing.
		const unregisterChannel = registerTerminalChannel(deviceId, channel, (offset, payload) => {
			lastOffset = offset + payload.length;
			send(encodeBinaryFrame({ kind: BIN_TERM_OUTPUT, channel: BROWSER_CHANNEL, offset, payload }));
		});
		const unsubscribeNotices = subscribeTerminalNotices(deviceId, terminalId, (notice) => {
			if (notice.kind === "terminal.exit") {
				sendJson({ t: "exit", code: notice.exitCode ?? 0 });
			}
		});
		teardownAttach = () => {
			unregisterChannel();
			unsubscribeNotices();
		};
		try {
			const result = await link.terminalAttach({
				terminalId,
				channel,
				...(from !== undefined ? { from } : {}),
			});
			if (closed) {
				teardownAttach?.();
				teardownAttach = null;
				return;
			}
			currentChannel = channel;
			lastOffset = result.from;
			if (result.reset) {
				sendJson({ t: "reset", prelude: result.prelude ?? "" });
			}
			audit("terminal.attach");
		} catch (err) {
			teardownAttach?.();
			teardownAttach = null;
			if (err instanceof OpError && err.code === "not_found") {
				// galopin restarted, or the terminal was closed elsewhere: there
				// is nothing to reattach to.
				sendJson({ t: "exit", code: 0 });
				return;
			}
			logger.warn({ err }, "terminal ws: attach failed");
		}
	}

	const unsubscribeConnection = subscribeDeviceConnection(deviceId, (online) => {
		if (closed) return;
		if (!online) {
			teardownAttach?.();
			teardownAttach = null;
			currentChannel = null;
			sendJson({ t: "machine-offline" });
			return;
		}
		sendJson({ t: "machine-online" });
		void attachToMachine(lastOffset);
	});

	const pingInterval = setInterval(() => {
		if (Date.now() - lastPongAt > PONG_DEAD_AFTER_MS) {
			ws.terminate();
			return;
		}
		try {
			ws.ping();
		} catch {
			/* already going away */
		}
	}, PING_INTERVAL_MS);

	const recheckInterval = setInterval(() => {
		void checkAuthorized({ userId: binding.userId, sessionId, deviceId: binding.deviceId }).then(
			(result) => {
				if (closed) return;
				if (!result.ok) {
					audit("terminal.refused");
					ws.close(4403, "logged out, revoked or unpaired");
				}
			}
		);
	}, RECHECK_INTERVAL_MS);

	ws.on("pong", () => {
		lastPongAt = Date.now();
	});

	ws.on("message", (raw: Buffer | string, isBinary: boolean) => {
		if (isBinary) {
			if (!Buffer.isBuffer(raw) || !currentChannel) return;
			const frame = decodeBinaryFrame(raw);
			if (!frame) return;
			if (frame.kind === BIN_TERM_INPUT) {
				if (frame.payload.length > MAX_INPUT_FRAME_PAYLOAD) return;
				sendTerminalInput(deviceId, currentChannel, frame.payload);
			} else if (frame.kind === BIN_TERM_ACK) {
				sendTerminalAck(deviceId, currentChannel, frame.offset);
			}
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const msg = parsed as { t?: unknown; cols?: unknown; rows?: unknown; claim?: unknown };
		if (
			msg.t === "resize" &&
			typeof msg.cols === "number" &&
			typeof msg.rows === "number" &&
			Number.isInteger(msg.cols) &&
			Number.isInteger(msg.rows) &&
			msg.cols > 0 &&
			msg.rows > 0 &&
			msg.cols <= 2000 &&
			msg.rows <= 2000
		) {
			void link
				.terminalResize({
					terminalId,
					cols: msg.cols,
					rows: msg.rows,
					...(typeof msg.claim === "boolean" ? { claim: msg.claim } : {}),
				})
				.catch(() => {
					/* the terminal may already be gone; the notice/exit path covers it */
				});
		}
	});

	function teardown(): void {
		if (closed) return;
		closed = true;
		clearInterval(pingInterval);
		clearInterval(recheckInterval);
		unsubscribeConnection();
		// Best effort, and only worth trying here: the browser tab is going
		// away on its own (close, navigate, crash) while the machine is very
		// likely still connected, so this is the one teardown path where a
		// real `terminal.detach` releases the machine-side viewer promptly
		// rather than leaving it to whatever reaps stale viewers there. The
		// other paths that tear down an attach (a machine reconnect, or the
		// machine going offline) have no live connection worth detaching on.
		if (currentChannel) {
			link.terminalDetach({ terminalId, channel: currentChannel }).catch(() => {
				/* the machine may already be gone; nothing to clean up then */
			});
		}
		teardownAttach?.();
		teardownAttach = null;
	}

	ws.on("close", teardown);
	ws.on("error", (err) => {
		logger.warn({ err }, "terminal ws: socket error");
	});

	void attachToMachine(initialFrom);
}
