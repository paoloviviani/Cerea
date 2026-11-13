import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { ManagerConfig } from "./config.ts";
import type { LeaseManager, ExecRequest } from "./leases.ts";
import { BadPath } from "./paths.ts";
import { HttpError, isRecord, parseJson, readBody, sendError, sendJson } from "../shared/http.ts";

/** Constant-time comparison of two secrets of any length (both are hashed first). */
export function tokenMatches(given: string, expected: string): boolean {
	const a = createHash("sha256").update(given).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

const JSON_LIMIT = 1_048_576;

export function createApi(config: ManagerConfig, leases: LeaseManager, version = "0.1.0") {
	let inflight = 0;
	let transfers = 0;
	const authorised = (req: http.IncomingMessage): boolean => {
		const header = req.headers.authorization ?? "";
		const m = /^Bearer (.+)$/.exec(header);
		return m !== null && tokenMatches(m[1], config.token);
	};

	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://manager");
		const method = req.method ?? "GET";
		const path = url.pathname;

		if (method === "GET" && path === "/v1/health") {
			// No token: the container health check and Cerea's start-up line need it. It says nothing
			// about who or what is running.
			return sendJson(res, 200, {
				status: "ok",
				version,
				runtime: config.runtime,
				machines: config.machinesEnabled,
			});
		}
		if (!authorised(req)) return sendError(res, 401, "unauthorized", "a service token is required");

		// Every lease route names its owner: a lease is only ever seen by the owner it was made for,
		// so a leaked or guessed lease id is not enough.
		const header = req.headers["x-sandbox-owner"];
		const owner = typeof header === "string" && header !== "" ? header : undefined;
		if (owner === undefined) {
			return sendError(res, 400, "owner_required", "X-Sandbox-Owner is required");
		}

		// Bound the work in flight before any body is read: a call can hold megabytes.
		if (inflight >= config.maxInflight) {
			return sendError(res, 503, "busy", "the manager has too many requests in flight");
		}
		inflight++;
		res.on("close", () => inflight--);

		if (path === "/v1/leases" && method === "POST") {
			const body = parseJson(await readBody(req, JSON_LIMIT));
			if (!isRecord(body)) throw new HttpError(400, "bad_json", "the body must be an object");
			if (body.owner !== owner) {
				throw new HttpError(
					400,
					"owner_mismatch",
					"X-Sandbox-Owner must equal the owner in the body"
				);
			}
			const lease = await leases.create({
				kind: body.kind as "exec" | "machine",
				owner: body.owner as string,
				conversation: body.conversation as string | undefined,
				limits: toLimits(body.limits),
			});
			return sendJson(res, 201, leases.view(lease));
		}

		const m = /^\/v1\/leases\/([0-9a-f]{24})(?:\/(exec|files\/(.*)))?$/.exec(path);
		if (!m) return sendError(res, 404, "not_found", "no such route");
		const [, id, sub, rawFile] = m;

		if (!sub && method === "GET") return sendJson(res, 200, leases.view(leases.get(id, owner)));
		if (!sub && method === "DELETE") {
			leases.get(id, owner);
			await leases.release(id);
			res.writeHead(204).end();
			return;
		}
		if (sub === "exec" && method === "POST") {
			const body = parseJson(await readBody(req, JSON_LIMIT));
			if (!isRecord(body)) throw new HttpError(400, "bad_json", "the body must be an object");
			const out = await leases.exec(id, toExec(body), owner);
			return sendJson(res, 200, {
				exit_code: out.exitCode,
				stdout: out.stdout,
				stderr: out.stderr,
				truncated: out.truncated,
				timed_out: out.timedOut,
				duration_ms: out.durationMs,
			});
		}
		if (sub?.startsWith("files/")) {
			let file: string;
			try {
				file = decodeURIComponent(rawFile ?? "");
			} catch {
				throw new HttpError(400, "bad_path", "the path is not valid percent-encoding");
			}
			if (method === "PUT" || method === "GET") {
				if (transfers >= config.maxFileTransfers) {
					return sendError(res, 503, "busy", "too many file transfers in flight");
				}
				transfers++;
				res.on("close", () => transfers--);
			}
			if (method === "PUT") {
				const data = await readBody(req, config.maxFileBytes);
				await leases.putFile(id, file, data, owner);
				res.writeHead(204).end();
				return;
			}
			if (method === "GET") {
				const data = await leases.getFile(id, file, owner);
				res.writeHead(200, {
					"Content-Type": "application/octet-stream",
					"Content-Length": data.length,
				});
				res.end(data);
				return;
			}
		}
		return sendError(res, 405, "method_not_allowed", "method not allowed");
	}

	return http.createServer((req, res) => {
		handle(req, res).catch((err: unknown) => {
			if (res.headersSent) return res.destroy();
			if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
			if (err instanceof BadPath) return sendError(res, 400, "bad_path", err.message);
			sendError(res, 500, "internal", "internal error");
		});
	});
}

function toLimits(v: unknown) {
	if (v === undefined || v === null) return undefined;
	if (!isRecord(v)) throw new HttpError(400, "bad_limit", "limits must be an object");
	const map: Record<string, string> = {
		memory_mb: "memoryMb",
		cpus: "cpus",
		pids: "pids",
		workspace_mb: "workspaceMb",
		timeout_seconds: "timeoutSeconds",
		max_output_bytes: "maxOutputBytes",
		idle_seconds: "idleSeconds",
	};
	const out: Record<string, unknown> = {};
	for (const [k, val] of Object.entries(v)) {
		if (!(k in map)) throw new HttpError(400, "bad_limit", `unknown limit ${k}`);
		out[map[k]] = val;
	}
	return out;
}

function toExec(b: Record<string, unknown>): ExecRequest {
	return {
		cmd: b.cmd as string[] | undefined,
		command: b.command as string | undefined,
		timeoutSeconds: b.timeout_seconds as number | undefined,
		cwd: b.cwd as string | undefined,
		env: b.env as Record<string, string> | undefined,
		stdin: b.stdin as string | undefined,
		maxOutputBytes: b.max_output_bytes as number | undefined,
	};
}
