import http from "node:http";
import { Demuxer } from "../shared/dockerStream.ts";

export class DockerError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface ContainerInfo {
	Id: string;
	Config?: { Labels?: Record<string, string> | null };
	State?: { Running?: boolean; Status?: string };
	HostConfig?: Record<string, unknown>;
}

export interface ExecOptions {
	cmd: string[];
	user?: string;
	workingDir?: string;
	env?: string[];
	stdin?: Buffer;
	/** Stop reading, and report truncation, once stdout + stderr pass this many bytes. */
	maxOutputBytes: number;
	/** Give up on the connection after this long (the command carries its own `timeout`). */
	timeoutMs: number;
}

export interface ExecResult {
	exitCode: number | null;
	stdout: Buffer;
	stderr: Buffer;
	truncated: boolean;
	timedOut: boolean;
	/** The process was still running after the stream ended: the caller must destroy the container. */
	stillRunning: boolean;
	durationMs: number;
}

/** What the lease manager needs from Docker; tests substitute a fake. */
export interface DockerApi {
	ensureImage(image: string): Promise<void>;
	createContainer(name: string, spec: Record<string, unknown>): Promise<string>;
	start(id: string): Promise<void>;
	inspect(id: string): Promise<ContainerInfo | null>;
	remove(id: string): Promise<void>;
	listManaged(labelFilters: string[]): Promise<ContainerInfo[]>;
	cpuSeconds(id: string): Promise<number | null>;
	exec(id: string, options: ExecOptions): Promise<ExecResult>;
}

export interface DockerTarget {
	url?: string;
	socketPath?: string;
}

interface Reply {
	status: number;
	body: Buffer;
}

export class DockerClient implements DockerApi {
	private target: DockerTarget;
	constructor(target: DockerTarget) {
		this.target = target;
	}

	private reqOptions(method: string, path: string, headers: Record<string, string | number> = {}) {
		if (this.target.socketPath) {
			return { socketPath: this.target.socketPath, method, path, headers };
		}
		const u = new URL(this.target.url ?? "http://sandbox-socket-proxy:2375");
		return { host: u.hostname, port: Number(u.port || 80), method, path, headers };
	}

	private request(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs = 60_000
	): Promise<Reply> {
		return new Promise((resolve, reject) => {
			const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
			const headers: Record<string, string | number> = {};
			if (payload) {
				headers["Content-Type"] = "application/json";
				headers["Content-Length"] = payload.length;
			}
			const req = http.request(this.reqOptions(method, path, headers), (res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (c: Buffer) => {
					size += c.length;
					if (size > 8_388_608) {
						req.destroy(new Error("Docker reply too large"));
						return;
					}
					chunks.push(c);
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
				res.on("error", reject);
			});
			req.setTimeout(timeoutMs, () => req.destroy(new Error("Docker request timed out")));
			req.on("error", reject);
			req.end(payload);
		});
	}

	private fail(reply: Reply, what: string): never {
		let message = reply.body.toString("utf8").slice(0, 300);
		try {
			message = (JSON.parse(message) as { message?: string }).message ?? message;
		} catch {
			/* not JSON */
		}
		throw new DockerError(reply.status, `${what}: ${message}`);
	}

	async ensureImage(image: string): Promise<void> {
		const have = await this.request("GET", `/images/${encodeURI(image)}/json`);
		if (have.status === 200) return;
		const at = image.indexOf("@");
		const colon = image.lastIndexOf(":");
		const q =
			at < 0 && colon > image.lastIndexOf("/")
				? `fromImage=${encodeURIComponent(image.slice(0, colon))}&tag=${encodeURIComponent(image.slice(colon + 1))}`
				: `fromImage=${encodeURIComponent(image)}`;
		const pulled = await this.request("POST", `/images/create?${q}`, undefined, 600_000);
		if (pulled.status !== 200) this.fail(pulled, `pulling ${image}`);
		// Docker reports a failed pull inside a 200 stream.
		if (/"error"/.test(pulled.body.toString("utf8"))) this.fail(pulled, `pulling ${image}`);
	}

	async createContainer(name: string, spec: Record<string, unknown>): Promise<string> {
		const r = await this.request(
			"POST",
			`/containers/create?name=${encodeURIComponent(name)}`,
			spec
		);
		if (r.status !== 201) this.fail(r, "creating the sandbox");
		return (JSON.parse(r.body.toString("utf8")) as { Id: string }).Id;
	}

	async start(id: string): Promise<void> {
		const r = await this.request("POST", `/containers/${id}/start`);
		if (r.status !== 204 && r.status !== 304) this.fail(r, "starting the sandbox");
	}

	async inspect(id: string): Promise<ContainerInfo | null> {
		const r = await this.request("GET", `/containers/${id}/json`);
		if (r.status === 404) return null;
		if (r.status !== 200) this.fail(r, "inspecting the sandbox");
		return JSON.parse(r.body.toString("utf8")) as ContainerInfo;
	}

	async remove(id: string): Promise<void> {
		const r = await this.request("DELETE", `/containers/${id}?force=true&v=true`);
		if (r.status !== 204 && r.status !== 404) this.fail(r, "removing the sandbox");
	}

	async listManaged(labelFilters: string[]): Promise<ContainerInfo[]> {
		const filters = encodeURIComponent(JSON.stringify({ label: labelFilters }));
		const r = await this.request("GET", `/containers/json?all=true&filters=${filters}`);
		if (r.status !== 200) this.fail(r, "listing sandboxes");
		return (
			JSON.parse(r.body.toString("utf8")) as { Id: string; Labels?: Record<string, string> }[]
		).map((c) => ({ Id: c.Id, Config: { Labels: c.Labels ?? {} } }));
	}

	async cpuSeconds(id: string): Promise<number | null> {
		try {
			const r = await this.request(
				"GET",
				`/containers/${id}/stats?stream=false&one-shot=true`,
				undefined,
				5000
			);
			if (r.status !== 200) return null;
			const s = JSON.parse(r.body.toString("utf8")) as {
				cpu_stats?: { cpu_usage?: { total_usage?: number } };
			};
			const ns = s.cpu_stats?.cpu_usage?.total_usage;
			return typeof ns === "number" ? ns / 1e9 : null;
		} catch {
			return null;
		}
	}

	async exec(id: string, o: ExecOptions): Promise<ExecResult> {
		const started = Date.now();
		const created = await this.request("POST", `/containers/${id}/exec`, {
			AttachStdin: o.stdin !== undefined,
			AttachStdout: true,
			AttachStderr: true,
			Tty: false,
			Cmd: o.cmd,
			...(o.user ? { User: o.user } : {}),
			...(o.workingDir ? { WorkingDir: o.workingDir } : {}),
			...(o.env ? { Env: o.env } : {}),
		});
		if (created.status !== 201) this.fail(created, "creating the exec");
		const execId = (JSON.parse(created.body.toString("utf8")) as { Id: string }).Id;

		const demux = new Demuxer();
		let truncated = false;
		let timedOut = false;
		await new Promise<void>((resolve, reject) => {
			const req = http.request(
				this.reqOptions("POST", `/exec/${execId}/start`, {
					"Content-Type": "application/json",
					Connection: "Upgrade",
					Upgrade: "tcp",
				})
			);
			let finished = false;
			const done = (err?: Error) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				if (err) reject(err);
				else resolve();
			};
			const timer = setTimeout(() => {
				timedOut = true;
				req.destroy();
				done();
			}, o.timeoutMs);
			req.on("response", (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () =>
					done(
						new DockerError(
							res.statusCode ?? 0,
							`starting the exec: ${Buffer.concat(chunks).toString("utf8").slice(0, 200)}`
						)
					)
				);
			});
			req.on("upgrade", (_res, socket, head) => {
				const take = (c: Buffer) => {
					demux.push(c);
					if (demux.total > o.maxOutputBytes) {
						truncated = true;
						socket.destroy();
					}
				};
				if (head.length) take(head);
				socket.on("data", take);
				socket.on("close", () => done());
				socket.on("error", () => done());
				if (o.stdin !== undefined) socket.end(o.stdin);
			});
			req.on("error", (e) => done(e));
			req.end(JSON.stringify({ Detach: false, Tty: false }));
		});

		let exitCode: number | null = null;
		let running = true;
		for (let i = 0; i < 20 && running; i++) {
			const r = await this.request("GET", `/exec/${execId}/json`);
			if (r.status === 200) {
				const j = JSON.parse(r.body.toString("utf8")) as {
					Running: boolean;
					ExitCode: number | null;
				};
				running = j.Running;
				exitCode = j.Running ? null : j.ExitCode;
			}
			if (running) await new Promise((r2) => setTimeout(r2, 100));
		}
		let stdout = Buffer.concat(demux.stdout);
		let stderr = Buffer.concat(demux.stderr);
		if (truncated) {
			// Keep the total within the bound.
			stdout = stdout.subarray(0, o.maxOutputBytes);
			stderr = stderr.subarray(0, Math.max(0, o.maxOutputBytes - stdout.length));
		}
		return {
			exitCode,
			stdout,
			stderr,
			truncated,
			timedOut,
			stillRunning: running,
			durationMs: Date.now() - started,
		};
	}
}
