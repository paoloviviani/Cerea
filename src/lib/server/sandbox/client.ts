/**
 * A typed client of the sandbox manager's HTTP API (ADR 0115). The manager is only ever reached by
 * URL and service token. `execute_code` runs through it (`codeExecution/serverBackend.ts`) when CHAT_CODE_EXECUTION=server.
 *
 * Every answer is parsed with zod; optional fields are `.nullish()` because a gateway or a proxy in
 * between may turn an absent field into null.
 */

import { z } from "zod";

export type LeaseKind = "exec" | "machine";

export interface LeaseLimits {
	memory_mb?: number;
	cpus?: number;
	pids?: number;
	workspace_mb?: number;
	timeout_seconds?: number;
	max_output_bytes?: number;
	idle_seconds?: number;
}

const limitsSchema = z.object({
	memory_mb: z.number().nullish(),
	cpus: z.number().nullish(),
	pids: z.number().nullish(),
	workspace_mb: z.number().nullish(),
	timeout_seconds: z.number().nullish(),
	max_output_bytes: z.number().nullish(),
	idle_seconds: z.number().nullish(),
});

const leaseSchema = z.object({
	id: z.string(),
	kind: z.enum(["exec", "machine"]),
	owner: z.string(),
	conversation: z.string().nullish(),
	state: z.string(),
	created_at: z.string().nullish(),
	last_active_at: z.string().nullish(),
	idle_expires_at: z.string().nullish(),
	limits: limitsSchema.nullish(),
	usage: z
		.object({
			exec_calls: z.number().nullish(),
			exec_seconds: z.number().nullish(),
			wall_seconds: z.number().nullish(),
		})
		.nullish(),
});
export type SandboxLease = z.infer<typeof leaseSchema>;

const execSchema = z.object({
	exit_code: z.number().nullable(),
	stdout: z.string(),
	stderr: z.string(),
	truncated: z.boolean(),
	timed_out: z.boolean(),
	duration_ms: z.number().nullish(),
});
export type SandboxExecResult = z.infer<typeof execSchema>;

const healthSchema = z.object({
	status: z.string(),
	version: z.string().nullish(),
	runtime: z.string().nullish(),
	machines: z.boolean().nullish(),
});
export type SandboxHealth = z.infer<typeof healthSchema>;

export interface ExecRequest {
	/** Exactly one of `cmd` (an argument list) or `command` (a shell string). */
	cmd?: string[];
	command?: string;
	timeoutSeconds?: number;
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string;
	maxOutputBytes?: number;
}

/** A failed call. `code` is the manager's own (`quota_exceeded`, `no_such_lease`, ...) or `unreachable`. */
export class SandboxError extends Error {
	status: number;
	code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "SandboxError";
		this.status = status;
		this.code = code;
	}
}

export interface SandboxClientOptions {
	url: string;
	token: string;
	fetch?: typeof fetch;
	/** Added to a call's own time limit for the HTTP timeout. */
	slackMs?: number;
}

const DEFAULT_CALL_MS = 15_000;

export class SandboxClient {
	private url: string;
	private token: string;
	private fetchImpl: typeof fetch;
	private slackMs: number;

	constructor(options: SandboxClientOptions) {
		this.url = options.url.replace(/\/+$/, "");
		this.token = options.token;
		this.fetchImpl = options.fetch ?? fetch;
		this.slackMs = options.slackMs ?? 10_000;
	}

	private async send(
		method: string,
		path: string,
		init: {
			json?: unknown;
			body?: Uint8Array;
			owner?: string;
			authorised?: boolean;
			timeoutMs?: number;
		} = {}
	): Promise<Response> {
		const headers: Record<string, string> = {};
		if (init.authorised !== false) headers.Authorization = `Bearer ${this.token}`;
		if (init.owner) headers["X-Sandbox-Owner"] = init.owner;
		let body: BodyInit | undefined;
		if (init.json !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(init.json);
		} else if (init.body) {
			headers["Content-Type"] = "application/octet-stream";
			body = init.body as BodyInit;
		}
		let res: Response;
		try {
			res = await this.fetchImpl(this.url + path, {
				method,
				headers,
				body,
				signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_CALL_MS),
				redirect: "error",
			});
		} catch (err) {
			throw new SandboxError(
				0,
				"unreachable",
				`the sandbox manager did not answer: ${String(err)}`
			);
		}
		if (!res.ok) {
			let code = "error";
			let message = `the sandbox manager answered ${res.status}`;
			try {
				const j = (await res.json()) as { error?: { code?: string; message?: string } | null };
				code = j?.error?.code ?? code;
				message = j?.error?.message ?? message;
			} catch {
				/* not JSON */
			}
			throw new SandboxError(res.status, code, message);
		}
		return res;
	}

	private async parsed<T>(res: Response, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
		const result = schema.safeParse(await res.json());
		if (!result.success) {
			throw new SandboxError(
				502,
				"bad_reply",
				"the sandbox manager's answer has an unexpected shape"
			);
		}
		return result.data;
	}

	/** Needs no token; what the start-up log line and the admin screen use. */
	async health(): Promise<SandboxHealth> {
		return this.parsed(
			await this.send("GET", "/v1/health", { authorised: false, timeoutMs: 5_000 }),
			healthSchema
		);
	}

	async lease(request: {
		kind: LeaseKind;
		owner: string;
		conversation?: string;
		limits?: LeaseLimits;
	}): Promise<SandboxLease> {
		// The manager requires the owner header on every lease route, and on a create it must be the body's.
		return this.parsed(
			await this.send("POST", "/v1/leases", {
				json: request,
				owner: request.owner,
				timeoutMs: 600_000,
			}),
			leaseSchema
		);
	}

	async status(id: string, owner: string): Promise<SandboxLease> {
		return this.parsed(await this.send("GET", `/v1/leases/${id}`, { owner }), leaseSchema);
	}

	async release(id: string, owner: string): Promise<void> {
		await this.send("DELETE", `/v1/leases/${id}`, { owner });
	}

	async exec(id: string, request: ExecRequest, owner: string): Promise<SandboxExecResult> {
		const timeout = (request.timeoutSeconds ?? 30) * 1000 + this.slackMs;
		const res = await this.send("POST", `/v1/leases/${id}/exec`, {
			owner,
			timeoutMs: timeout,
			json: {
				cmd: request.cmd,
				command: request.command,
				timeout_seconds: request.timeoutSeconds,
				cwd: request.cwd,
				env: request.env,
				stdin: request.stdin,
				max_output_bytes: request.maxOutputBytes,
			},
		});
		return this.parsed(res, execSchema);
	}

	async putFile(id: string, path: string, data: Uint8Array, owner: string): Promise<void> {
		await this.send("PUT", `/v1/leases/${id}/files/${encodePath(path)}`, {
			owner,
			body: data,
			timeoutMs: 60_000,
		});
	}

	async getFile(id: string, path: string, owner: string): Promise<Uint8Array> {
		const res = await this.send("GET", `/v1/leases/${id}/files/${encodePath(path)}`, {
			owner,
			timeoutMs: 60_000,
		});
		return new Uint8Array(await res.arrayBuffer());
	}
}

/**
 * Each segment encoded on its own. A `.` or `..` segment is sent as %2E, because fetch would
 * otherwise collapse it before the manager sees it; the manager refuses `..` itself.
 */
function encodePath(path: string): string {
	return path
		.split("/")
		.filter((s) => s !== "")
		.map((seg) =>
			seg === "." || seg === ".." ? seg.replace(/\./g, "%2E") : encodeURIComponent(seg)
		)
		.join("/");
}
