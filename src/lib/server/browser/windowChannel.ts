/**
 * The window browser's WebSocket: `GET ${base}/api/v2/browser/window?ticket=...` (ADR 0122).
 *
 * Like the machine link and the terminal it is a raw `http.Server` upgrade below SvelteKit, so
 * hooks never run on it and every check is made here: the deployment's switch, the `Origin`
 * header (the one origin this deployment answers as, before the ticket is looked at), the single
 * use ticket (minted through the ordinary hooks for this user, session and window id), and that
 * the session still exists. The session is looked at again every minute on the open socket, and
 * the socket closes 4403 when it is gone.
 *
 * What crosses is MCP JSON-RPC and nothing else: down, `tools/call` for the contract's tools; up,
 * answers (`windowRegistry.ts` parses them strictly). No secret crosses it.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { base } from "$app/paths";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { browserEnabled } from "./settings";
import { redeemWindowTicket, type WindowTicketBinding } from "./windowTickets";
import {
	MAX_WINDOW_MESSAGE_BYTES,
	handleWindowMessage,
	registerWindow,
	unregisterWindow,
} from "./windowRegistry";

export const WINDOW_PATH = "/api/v2/browser/window";

const PING_INTERVAL_MS = 20_000;
const PONG_DEAD_AFTER_MS = 60_000;
let recheckIntervalMs = 60_000;
/** Test-only: shrink the session re-check for one test. */
export function _setWindowRecheckMsForTests(ms: number): void {
	recheckIntervalMs = ms;
}

export interface WindowChannelDeps {
	/** Whether the session is still signed in as this user (default: the sessions collection). */
	sessionValid(userId: string, sessionId: string): Promise<boolean>;
}

const mongoDeps: WindowChannelDeps = {
	async sessionValid(userId, sessionId) {
		const session = await collections.sessions.findOne({
			sessionId,
			expiresAt: { $gt: new Date() },
		});
		return !!session && session.userId.toString() === userId;
	},
};

function reject(socket: Duplex, status: number, message: string): void {
	const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found";
	socket.write(
		`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
			`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
	);
	socket.destroy();
}

function expectedOrigin(): string | null {
	if (!config.PUBLIC_ORIGIN) return null;
	try {
		return new URL(config.PUBLIC_ORIGIN).origin;
	} catch {
		return null;
	}
}

const wss = new WebSocketServer({
	noServer: true,
	maxPayload: MAX_WINDOW_MESSAGE_BYTES,
});

export async function handleWindowUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	deps: WindowChannelDeps = mongoDeps
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://internal");
	if (url.pathname !== `${base}${WINDOW_PATH}`) {
		socket.destroy();
		return;
	}
	if (!browserEnabled()) return reject(socket, 404, "Browser use is not turned on here.");
	// Cross-site WebSocket hijacking: a foreign origin is refused before the ticket is spent.
	const expected = expectedOrigin();
	if (!expected || req.headers.origin !== expected) {
		logger.warn({ origin: req.headers.origin }, "window browser ws: origin refused");
		return reject(socket, 403, "Origin not allowed.");
	}
	const ticket = url.searchParams.get("ticket");
	if (!ticket) return reject(socket, 401, "A ticket is required.");
	const binding = redeemWindowTicket(ticket);
	if (!binding) return reject(socket, 401, "Invalid or expired ticket.");
	if (!(await deps.sessionValid(binding.userId, binding.sessionId).catch(() => false))) {
		return reject(socket, 403, "Signed out.");
	}
	wss.handleUpgrade(req, socket, head, (ws) => accept(ws, binding, deps));
}

function accept(ws: WebSocket, binding: WindowTicketBinding, deps: WindowChannelDeps): void {
	let lastPongAt = Date.now();
	const window = registerWindow({
		...binding,
		transport: {
			send: (text) => {
				if (ws.readyState === ws.OPEN) ws.send(text);
			},
			close: (code, reason) => {
				try {
					ws.close(code, reason);
				} catch {
					/* already going away */
				}
			},
		},
	});
	const ping = setInterval(() => {
		if (Date.now() - lastPongAt > PONG_DEAD_AFTER_MS) return void ws.terminate();
		try {
			ws.ping();
		} catch {
			/* already going away */
		}
	}, PING_INTERVAL_MS);
	const recheck = setInterval(() => {
		deps
			.sessionValid(binding.userId, binding.sessionId)
			.then((ok) => {
				if (!ok) ws.close(4403, "signed out");
			})
			.catch((err: unknown) => logger.warn({ err }, "window browser ws: recheck failed"));
	}, recheckIntervalMs);
	ws.on("pong", () => {
		lastPongAt = Date.now();
	});
	ws.on("message", (raw: Buffer | string, isBinary: boolean) => {
		// Text only: a binary frame is not part of this protocol.
		if (isBinary) {
			ws.close(4400, "text only");
			return;
		}
		handleWindowMessage(window, raw.toString());
	});
	ws.on("close", () => {
		clearInterval(ping);
		clearInterval(recheck);
		unregisterWindow(window, "the window closed or switched profile");
	});
	ws.on("error", (err) => logger.warn({ err }, "window browser ws: socket error"));
}
