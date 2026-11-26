/**
 * Where the runtime reaches the bridge: a WebSocket on a Unix domain socket (mode 0600, in a
 * directory only this user can enter), with a path that carries a secret made fresh at every
 * start. There is no TCP port, so no web page and no other computer can reach it; another OS
 * user cannot open the socket; another process of the same user must also read the 0600 endpoint
 * file to know the secret. The endpoint is written to a file the runtime reads each time it
 * connects (`--connect-file`), so it survives app restarts without any configuration change.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	lstatSync,
	mkdirSync,
	openSync,
	rmSync,
	writeSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Transport } from "./cdpBridge.ts";

export function socketPathFor(runDir: string, uid: number): string {
	const p = join(runDir, "cdp.sock");
	// sun_path is 104 bytes on macOS, 108 on Linux.
	return Buffer.byteLength(p) < 96 ? p : join(tmpdir(), `cerea-desktop-${uid}`, "cdp.sock");
}

/**
 * A directory only this user can enter. One that exists must be a real directory (not a symlink)
 * owned by this user with no group or world access; anything else is refused rather than trusted
 * (the fallback directory sits in a shared temp directory where another user could have made it).
 */
export function ensurePrivateDir(dir: string, uid: number): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = lstatSync(dir);
	if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain directory.`);
	if (process.platform !== "win32") {
		if (st.uid !== uid) throw new Error(`${dir} belongs to another user.`);
		if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
		if ((lstatSync(dir).mode & 0o077) !== 0) throw new Error(`${dir} is open to other users.`);
	}
}

/**
 * Writes the endpoint file without following a link planted at its path (the directory is the
 * user's own, but a galopin directory can hold files other tools made): an existing link or
 * non-file is removed first, and the open itself refuses a link (O_NOFOLLOW).
 */
export function writeEndpointFile(file: string, text: string): void {
	try {
		const st = lstatSync(file);
		if (!st.isFile()) rmSync(file, { recursive: true, force: true });
	} catch {
		// nothing there
	}
	const fd = openSync(
		file,
		constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
		0o600
	);
	try {
		writeSync(fd, text);
		fchmodSync(fd, 0o600);
	} finally {
		closeSync(fd);
	}
}

export interface ModeSource {
	current(): "agent" | "user";
	/** The runtime's control stream connected: a sign that it is working (opens the panel). */
	touch?(): void;
	onChange(cb: () => void): () => void;
}

export const modeEvent = (mode: "agent" | "user") => `data: ${JSON.stringify({ mode })}\n\n`;

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export interface BridgeServer {
	/** The socket every profile's runtime connects to (each with its own secret). */
	socket: string;
	/**
	 * Gives a profile its own secret and writes its endpoint file into `dir` (that profile's galopin
	 * directory), 0600. The runtime of that profile's galopin is registered with this file.
	 */
	addProfile(id: string, dir: string, secret?: string): string;
	removeProfile(id: string): void;
	/** The profile whose runtime is served now; streams of any other end. */
	setActive(id: string | null): void;
	endpointFile(id: string): string | undefined;
	/**
	 * The same bridge under a second secret, for the app's own window runtime only: a connection made
	 * with it is known to be that runtime's (a refusal can then be told apart from a galopin's).
	 */
	windowEndpointFile(id: string): string | undefined;
	close(): Promise<void>;
}

export const OTHER_PROFILE = "This browser belongs to another profile.";

/**
 * One socket, one secret per profile, and only the active profile's secret is served: a galopin of
 * an inactive profile (a `galopin run` or a shim outside the app, say) cannot drive the panel of the
 * profile that is open. It is told so, and its connection is refused.
 */
export async function startBridgeServer(
	bridge: { connect(t: Transport, own?: boolean): void; disconnect(): void },
	opts: {
		runDir: string;
		uid: number;
		control?: ModeSource;
		/** The active profile's id. */
		active: () => string | null;
	}
): Promise<BridgeServer> {
	const sock = socketPathFor(opts.runDir, opts.uid);
	for (const dir of new Set([opts.runDir, join(sock, "..")])) ensurePrivateDir(dir, opts.uid);
	if (existsSync(sock)) rmSync(sock);
	const secrets = new Map<
		string,
		{ secret: string; file: string; windowSecret: string; windowFile: string }
	>();
	/**
	 * Which profile a request path belongs to, comparing against every secret in constant time per
	 * secret, and whether it came in under the app's own window-runtime secret.
	 */
	const owner = (
		url: string,
		kind: "cdp" | "ctl"
	): { id: string; windowRuntime: boolean } | undefined => {
		let found: { id: string; windowRuntime: boolean } | undefined;
		for (const [id, v] of secrets) {
			if (safeEqual(url, `/${kind}/${v.secret}`)) found = { id, windowRuntime: false };
			if (safeEqual(url, `/${kind}/${v.windowSecret}`)) found = { id, windowRuntime: true };
		}
		return found;
	};
	const streams = new Map<http.ServerResponse, string>();
	const unwatch = opts.control?.onChange(() => {
		for (const res of streams.keys()) res.write(modeEvent(opts.control!.current()));
	});
	const server = http.createServer((req, res) => {
		// Who is driving, pushed to the runtime: one event now and one on every change. The same
		// secret rules as the CDP socket (no Origin, exact path, the active profile's secret).
		const id =
			opts.control && req.method === "GET" && !req.headers.origin
				? owner(req.url ?? "", "ctl")?.id
				: undefined;
		if (id !== undefined) {
			if (id !== opts.active()) {
				res.writeHead(403, { "content-type": "text/plain" });
				return void res.end(OTHER_PROFILE);
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
			res.write(modeEvent(opts.control!.current()));
			streams.set(res, id);
			opts.control!.touch?.();
			res.on("close", () => streams.delete(res));
			return;
		}
		res.statusCode = 404;
		res.end();
	});
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: 32 * 1024 * 1024,
		perMessageDeflate: false,
	});
	server.on("upgrade", (req, socket, head) => {
		// A browser always sends Origin; the runtime never does.
		const who = req.headers.origin ? undefined : owner(req.url ?? "", "cdp");
		const id = who?.id;
		if (id === undefined) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		if (id !== opts.active()) {
			socket.write(
				`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${OTHER_PROFILE}`
			);
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) =>
			bridge.connect(wsTransport(ws), who?.windowRuntime === true)
		);
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
	return {
		socket: sock,
		addProfile(id, dir, secret = randomBytes(32).toString("base64url")) {
			ensurePrivateDir(dir, opts.uid);
			const file = join(dir, "cdp-endpoint");
			const windowFile = join(dir, "cdp-endpoint-window");
			const windowSecret = randomBytes(32).toString("base64url");
			writeEndpointFile(file, `ws+unix://${sock}:/cdp/${secret}\n`);
			writeEndpointFile(windowFile, `ws+unix://${sock}:/cdp/${windowSecret}\n`);
			// A profile that moves to another directory leaves nothing behind that carries its secret.
			const prev = secrets.get(id);
			if (prev && prev.file !== file) rmSync(prev.file, { force: true });
			if (prev && prev.windowFile !== windowFile) rmSync(prev.windowFile, { force: true });
			secrets.set(id, { secret, file, windowSecret, windowFile });
			return file;
		},
		removeProfile(id) {
			const v = secrets.get(id);
			secrets.delete(id);
			if (v) (rmSync(v.file, { force: true }), rmSync(v.windowFile, { force: true }));
			for (const [res, owner] of streams) if (owner === id) (res.end(), streams.delete(res));
		},
		setActive(id) {
			for (const [res, owner] of streams) if (owner !== id) (res.end(), streams.delete(res));
		},
		endpointFile: (id) => secrets.get(id)?.file,
		windowEndpointFile: (id) => secrets.get(id)?.windowFile,
		close: () =>
			new Promise<void>((resolve) => {
				unwatch?.();
				for (const res of streams.keys()) res.end();
				bridge.disconnect();
				for (const c of wss.clients) c.terminate();
				for (const v of secrets.values())
					(rmSync(v.file, { force: true }), rmSync(v.windowFile, { force: true }));
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
		close: (reason) => (reason ? ws.close(1013, reason.slice(0, 120)) : ws.close()),
	};
}
