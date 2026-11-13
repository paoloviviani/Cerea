import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { authorize, type PolicyConfig, type PolicyDeps } from "./policy.ts";
import { HttpError, logLine, readBody } from "../shared/http.ts";
import { DuplicateKeyError, canonicalBody, parseStrictJson } from "../shared/strictjson.ts";

export interface Upstream {
	socketPath?: string;
	host?: string;
	port?: number;
}

const BODY_LIMIT = 65_536;

function isExecStart(path: string): boolean {
	return /^\/exec\/[a-f0-9]{64}\/start$/.test(new URL(path, "http://d").pathname);
}

function upstreamJson(up: Upstream, path: string): Promise<{ status: number; body: unknown }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ ...up, method: "GET", path, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				let body: unknown = null;
				try {
					body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				} catch {
					/* not JSON */
				}
				resolve({ status: res.statusCode ?? 0, body });
			});
		});
		req.setTimeout(10_000, () => req.destroy(new Error("upstream timeout")));
		req.on("error", reject);
		req.end();
	});
}

export function dockerDeps(up: Upstream): PolicyDeps {
	return {
		async containerInfo(id) {
			const r = await upstreamJson(up, `/containers/${encodeURIComponent(id)}/json`);
			if (r.status !== 200) return null;
			const b = r.body as { Id?: string; Config?: { Labels?: Record<string, string> } };
			if (typeof b?.Id !== "string") return null;
			return { id: b.Id, labels: b.Config?.Labels ?? {} };
		},
		async execContainer(execId) {
			const r = await upstreamJson(up, `/exec/${encodeURIComponent(execId)}/json`);
			if (r.status !== 200) return null;
			return (r.body as { ContainerID?: string })?.ContainerID ?? null;
		},
	};
}

/**
 * The proxy: reads each request (the body is small and bounded), asks `authorize`, and only then
 * forwards it to Docker. An exec start is a hijacked connection, so after the check the two
 * sockets are piped together, half-close included.
 */
export function createProxy(up: Upstream, cfg: PolicyConfig, deps: PolicyDeps = dockerDeps(up)) {
	const refuse = (
		res: http.ServerResponse,
		status: number,
		reason: string,
		req: http.IncomingMessage
	) => {
		logLine({
			level: "warn",
			msg: "denied",
			method: req.method,
			path: (req.url ?? "").split("?")[0],
			reason,
		});
		const text = JSON.stringify({ message: `sandbox socket proxy: ${reason}` });
		res.writeHead(status, {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(text),
		});
		res.end(text);
	};

	const server = http.createServer(async (req, res) => {
		try {
			const raw = await readBody(req, BODY_LIMIT);
			let body: unknown = undefined;
			if (raw.length) {
				try {
					body = parseStrictJson(raw.toString("utf8"));
				} catch (err) {
					return refuse(
						res,
						400,
						err instanceof DuplicateKeyError ? "the body repeats a key" : "the body is not JSON",
						req
					);
				}
			}
			const v = await authorize(req.method ?? "GET", req.url ?? "/", body, cfg, deps);
			if (!v.allow) return refuse(res, v.status, v.reason, req);
			if (isExecStart(v.path)) return refuse(res, 400, "an exec start must be an upgrade", req);
			// One upstream connection per request, closed after it: a reply can never be followed by
			// bytes Docker parses as another request.
			// What is forwarded is what was checked, re-serialised: never the client's bytes.
			const forward = body === undefined ? Buffer.alloc(0) : canonicalBody(body);
			const headers: http.OutgoingHttpHeaders = { host: "docker", connection: "close" };
			if (forward.length) {
				headers["content-type"] = "application/json";
				headers["content-length"] = forward.length;
			}
			const out = http.request(
				{ ...up, method: req.method, path: v.path, headers, agent: false },
				(r) => {
					res.writeHead(r.statusCode ?? 502, r.headers);
					r.pipe(res);
				}
			);
			out.on("error", () => refuse(res, 502, "Docker did not answer", req));
			out.end(forward);
		} catch (err) {
			if (err instanceof HttpError) return refuse(res, err.status, err.message, req);
			refuse(res, 500, "proxy error", req);
		}
	});

	server.on("upgrade", async (req, socket: Duplex, head: Buffer) => {
		const fail = (status: number, reason: string) => {
			logLine({
				level: "warn",
				msg: "denied",
				method: req.method,
				path: (req.url ?? "").split("?")[0],
				reason,
			});
			socket.end(
				`HTTP/1.1 ${status} Denied\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ message: reason })}`
			);
		};
		try {
			// The body's extent must be unambiguous: one plain Content-Length, no chunking.
			if (req.headers["transfer-encoding"] !== undefined) return fail(400, "no transfer-encoding");
			const declared = req.headers["content-length"];
			if (typeof declared !== "string" || !/^\d{1,6}$/.test(declared)) {
				return fail(400, "a Content-Length is required");
			}
			const length = Number(declared);
			if (length > BODY_LIMIT) return fail(413, "body too large");
			// The JSON body follows the headers on the same connection: some of it is in `head`.
			let raw = head;
			while (raw.length < length) {
				raw = Buffer.concat([
					raw,
					await new Promise<Buffer>((resolve, reject) => {
						socket.once("data", resolve);
						socket.once("error", reject);
						socket.once("close", () => reject(new Error("closed")));
					}),
				]);
			}
			// Nothing may follow the request: it would be parsed as another one.
			if (raw.length !== length) return fail(400, "bytes after the request body");
			let parsed: unknown;
			try {
				parsed = length ? parseStrictJson(raw.toString("utf8")) : undefined;
			} catch (err) {
				return fail(
					400,
					err instanceof DuplicateKeyError ? "the body repeats a key" : "the body is not JSON"
				);
			}
			const v = await authorize(req.method ?? "GET", req.url ?? "/", parsed, cfg, deps);
			if (!v.allow) return fail(v.status, v.reason);
			if (!isExecStart(v.path)) return fail(403, "only an exec start may upgrade");

			const forward = parsed === undefined ? Buffer.alloc(0) : canonicalBody(parsed);
			socket.pause(); // nothing of the client's is forwarded until Docker has said 101
			const upstream = up.socketPath
				? net.connect({ path: up.socketPath, allowHalfOpen: true })
				: net.connect({ port: up.port ?? 80, host: up.host, allowHalfOpen: true });
			upstream.setTimeout(15_000, () => {
				upstream.destroy();
				socket.destroy();
			});
			upstream.on("error", () => socket.destroy());
			socket.on("error", () => upstream.destroy());
			socket.on("close", () => upstream.destroy());
			upstream.on("connect", () => {
				upstream.write(
					`POST ${v.path} HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: ${forward.length}\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`
				);
				upstream.write(forward);
			});
			let seen: Buffer = Buffer.alloc(0);
			const onHead = (chunk: Buffer) => {
				seen = Buffer.concat([seen, chunk]);
				const end = seen.indexOf("\r\n\r\n");
				if (end < 0) {
					if (seen.length > 16_384) {
						upstream.destroy();
						socket.destroy();
					}
					return;
				}
				upstream.off("data", onHead);
				upstream.pause();
				const status = /^HTTP\/1\.[01] (\d{3})/.exec(seen.subarray(0, end).toString("latin1"))?.[1];
				if (status !== "101") {
					// Anything but a hijack is relayed as it is and both connections are closed.
					socket.write(seen, () => socket.destroy());
					upstream.destroy();
					return;
				}
				upstream.setTimeout(0);
				socket.write(seen); // the 101 and whatever the process already printed
				socket.pipe(upstream);
				upstream.pipe(socket);
				socket.resume();
				upstream.resume();
			};
			upstream.on("data", onHead);
		} catch {
			fail(500, "proxy error");
		}
	});
	return server;
}
