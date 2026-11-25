/**
 * Where the runtime reaches the bridge: a WebSocket on a Unix domain socket (mode 0600, in a
 * directory only this user can enter), with a path that carries a secret made fresh at every
 * start. There is no TCP port, so no web page and no other computer can reach it; another OS
 * user cannot open the socket; another process of the same user must also read the 0600 endpoint
 * file to know the secret. The endpoint is written to a file the runtime reads each time it
 * connects (`--connect-file`), so it survives app restarts without any configuration change.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { CdpBridge, Transport } from "./cdpBridge.ts";

export function socketPathFor(runDir: string, uid: number): string {
	const p = join(runDir, "cdp.sock");
	// sun_path is 104 bytes on macOS, 108 on Linux.
	return Buffer.byteLength(p) < 96 ? p : join(tmpdir(), `cerea-desktop-${uid}`, "cdp.sock");
}

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export interface BridgeServer {
	endpointFile: string;
	endpoint: string;
	close(): Promise<void>;
}

export async function startBridgeServer(
	bridge: CdpBridge,
	opts: { runDir: string; uid: number; secret?: string }
): Promise<BridgeServer> {
	const secret = opts.secret ?? randomBytes(32).toString("base64url");
	const sock = socketPathFor(opts.runDir, opts.uid);
	for (const dir of new Set([opts.runDir, join(sock, "..")])) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	}
	if (existsSync(sock)) rmSync(sock);
	const server = http.createServer((_req, res) => {
		res.statusCode = 404;
		res.end();
	});
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: 32 * 1024 * 1024,
		perMessageDeflate: false,
	});
	const path = `/cdp/${secret}`;
	server.on("upgrade", (req, socket, head) => {
		// A browser always sends Origin; the runtime never does.
		const ok = !req.headers.origin && safeEqual(req.url ?? "", path);
		if (!ok) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => bridge.connect(wsTransport(ws)));
	});
	const oldMask = process.umask(0o177);
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(sock, resolve);
		});
	} finally {
		process.umask(oldMask);
	}
	chmodSync(sock, 0o600);
	const endpoint = `ws+unix://${sock}:${path}`;
	const endpointFile = join(opts.runDir, "cdp-endpoint");
	writeFileSync(endpointFile, endpoint + "\n", { mode: 0o600 });
	chmodSync(endpointFile, 0o600);
	return {
		endpointFile,
		endpoint,
		close: () =>
			new Promise<void>((resolve) => {
				bridge.disconnect();
				for (const c of wss.clients) c.terminate();
				rmSync(endpointFile, { force: true });
				server.close(() => resolve());
				server.closeAllConnections?.();
			}),
	};
}

function wsTransport(ws: WebSocket): Transport {
	return {
		send: (d) => ws.send(d),
		onMessage: (cb) => ws.on("message", (m) => cb(m.toString())),
		onClose: (cb) => ws.on("close", cb),
		close: () => ws.close(),
	};
}
