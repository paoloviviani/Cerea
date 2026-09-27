/**
 * The machine link's WebSocket endpoint: `GET /api/v2/code/machine`.
 *
 * SvelteKit's request handling (via adapter-node's `handler`) only speaks
 * HTTP; a WebSocket upgrade has to be intercepted one layer up, on the raw
 * `http.Server` polka creates. `server.js` owns that `upgrade` listener and
 * delegates to `registerMachineUpgrade`'s function, registered here on a
 * well-known global symbol from the server init hook — the same seam
 * `vite.config.ts`'s dev plugin uses so `npm run dev` gets the same endpoint.
 *
 * The handshake follows the spec (`reports/2026-09-24-thin-agent-protocol.md`
 * §3): the bearer is validated *before* the WebSocket upgrade completes where
 * possible (plain HTTP 401/403), so a bad credential never costs a socket.
 * Once upgraded, `machines.ts` owns the connection's whole lifecycle (hello,
 * welcome, registry, ops, events); this module is only the accept path.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { base } from "$app/paths";
import { MACHINE_PATH, MACHINE_PROTOCOL, TERMINAL_PATH } from "$lib/types/machineProtocol";
import { authenticateMachineRequest } from "$lib/server/code/machineAuth";
import { acceptMachineConnection } from "$lib/server/code/machines";
import { handleTerminalUpgrade } from "$lib/server/code/terminalServer";
import { logger } from "$lib/server/logger";

const MACHINE_UPGRADE_SYMBOL = Symbol.for("cerea.machineUpgrade");

function writeHttpRejection(socket: Duplex, status: number, message: string): void {
	const body = message;
	socket.write(
		`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}\r\n` +
			"Connection: close\r\n" +
			"Content-Type: text/plain\r\n" +
			`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
	);
	socket.destroy();
}

const wss = new WebSocketServer({ noServer: true });

async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
	const url = new URL(req.url ?? "/", "http://internal");
	// The upgrade arrives below SvelteKit, so the app's base path is still on
	// it: behind the Pystino stack (APP_BASE=/chat) the machine dials
	// /chat/api/v2/code/machine, and comparing against the bare path dropped
	// every machine socket.
	if (url.pathname !== `${base}${MACHINE_PATH}`) {
		socket.destroy();
		return;
	}

	// Rejections happen before the upgrade completes when possible (§3): a
	// bad or missing bearer, or a token whose `sub` maps to no Cerea user,
	// is a plain HTTP response, never a socket the machine has to open and
	// then watch close.
	const auth = await authenticateMachineRequest(req.headers).catch((err) => {
		logger.warn({ err }, "machine link: auth check failed");
		return { ok: false as const, status: 401 as const, message: "authentication failed" };
	});
	if (!auth.ok) {
		writeHttpRejection(socket, auth.status, auth.message);
		return;
	}

	wss.handleUpgrade(req, socket, head, (client) => {
		acceptMachineConnection(client, req, auth.principal, auth.token);
	});
}

/**
 * Register the upgrade function on the global symbol `server.js` (and the
 * dev plugin) call. Idempotent: called once from `initServer()`.
 *
 * `server.js`/the dev plugin forward every upgrade on the raw `http.Server`
 * to whatever single function is registered here — there is one seam, not
 * one per endpoint — so this dispatches by pathname between the machine
 * link (`MACHINE_PATH`) and the browser terminal socket (`TERMINAL_PATH`,
 * `terminalServer.ts`) rather than either module registering its own.
 */
export function registerMachineUpgrade(): void {
	(globalThis as Record<symbol, unknown>)[MACHINE_UPGRADE_SYMBOL] = (
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer
	) => {
		const url = new URL(req.url ?? "/", "http://internal");
		if (url.pathname === `${base}${TERMINAL_PATH}`) {
			void handleTerminalUpgrade(req, socket, head);
			return;
		}
		void handleUpgrade(req, socket, head);
	};
}

/** The subprotocol this endpoint advertises, exported for the dev plugin and tests. */
export const machineWebSocketProtocol = MACHINE_PROTOCOL;
