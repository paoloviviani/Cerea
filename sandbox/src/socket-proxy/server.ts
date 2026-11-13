import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { authorize, type PolicyConfig, type PolicyDeps } from "./policy.ts";
import { HttpError, logLine, readBody } from "../shared/http.ts";

export interface Upstream {
	socketPath?: string;
	host?: string;
	port?: number;
}

const BODY_LIMIT = 65_536;

function upstreamJson(up: Upstream, path: string): Promise<{ status: number; body: unknown }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ ...up, method: "GET", path }, (res) => {
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
		async containerLabels(id) {
			const r = await upstreamJson(up, `/containers/${encodeURIComponent(id)}/json`);
			if (r.status !== 200) return null;
			return ((r.body as { Config?: { Labels?: Record<string, string> } })?.Config?.Labels ??
				{}) as Record<string, string>;
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
					body = JSON.parse(raw.toString("utf8"));
				} catch {
					return refuse(res, 400, "the body is not JSON", req);
				}
			}
			const v = await authorize(req.method ?? "GET", req.url ?? "/", body, cfg, deps);
			if (!v.allow) return refuse(res, v.status, v.reason, req);
			const headers: http.OutgoingHttpHeaders = { host: "docker" };
			if (raw.length) {
				headers["content-type"] = "application/json";
				headers["content-length"] = raw.length;
			}
			const out = http.request({ ...up, method: req.method, path: v.path, headers }, (r) => {
				res.writeHead(r.statusCode ?? 502, r.headers);
				r.pipe(res);
			});
			out.on("error", () => refuse(res, 502, "Docker did not answer", req));
			out.end(raw);
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
			const length = Number(req.headers["content-length"] ?? "0");
			if (!Number.isFinite(length) || length > BODY_LIMIT) return fail(413, "body too large");
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
			const body = raw.subarray(0, length);
			const rest = raw.subarray(length);
			let parsed: unknown;
			try {
				parsed = body.length ? JSON.parse(body.toString("utf8")) : undefined;
			} catch {
				return fail(400, "the body is not JSON");
			}
			const v = await authorize(req.method ?? "GET", req.url ?? "/", parsed, cfg, deps);
			if (!v.allow) return fail(v.status, v.reason);
			if (!/^\/(v\d+\.\d+\/)?exec\/[^/]+\/start$/.test(new URL(v.path, "http://d").pathname)) {
				return fail(403, "only an exec start may upgrade");
			}
			const upstream = up.socketPath
				? net.connect(up.socketPath)
				: net.connect(up.port ?? 80, up.host);
			upstream.on("error", () => socket.destroy());
			socket.on("error", () => upstream.destroy());
			upstream.on("connect", () => {
				upstream.write(
					`POST ${v.path} HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`
				);
				upstream.write(body);
				if (rest.length) upstream.write(rest);
				socket.pipe(upstream);
				upstream.pipe(socket);
			});
		} catch {
			fail(500, "proxy error");
		}
	});
	return server;
}
