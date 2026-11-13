import { createHash, randomBytes } from "node:crypto";
import type { Audit } from "./audit.ts";
import type { DockerApi, ExecResult } from "./docker.ts";
import { DockerError } from "./docker.ts";
import type { LeaseLimits, ManagerConfig } from "./config.ts";
import { HttpError } from "../shared/http.ts";
import { LABEL_INSTANCE, LABEL_LEASE, LABEL_MANAGED, isManaged } from "../shared/labels.ts";
import { WORKSPACE, workspaceDir, workspacePath } from "./paths.ts";
import { containerName, execContainerSpec } from "./spec.ts";

export type LeaseKind = "exec" | "machine";
export type LeaseState = "creating" | "ready" | "released";

export interface Lease {
	id: string;
	kind: LeaseKind;
	owner: string;
	conversation: string | null;
	state: LeaseState;
	containerId: string | null;
	limits: LeaseLimits;
	createdAt: number;
	lastActiveAt: number;
	activeExecs: number;
	usage: { execCalls: number; execSeconds: number; cpuSeconds: number | null };
}

/** What a lease cost, handed to the billing seam when it is released. */
export interface UsageRecord {
	lease: string;
	owner: string;
	kind: LeaseKind;
	wallSeconds: number;
	execSeconds: number;
	execCalls: number;
	cpuSeconds: number | null;
	reason: string;
}

/** The seam for billing: step 1 only audits it. */
export type UsageSink = (record: UsageRecord) => void;

export interface CreateRequest {
	kind: LeaseKind;
	owner: string;
	conversation?: string;
	limits?: Partial<LeaseLimits>;
}

export interface ExecRequest {
	cmd?: string[];
	command?: string;
	timeoutSeconds?: number;
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string;
	maxOutputBytes?: number;
}

export interface ExecResponse {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
	durationMs: number;
}

const OWNER_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

export class LeaseManager {
	private leases = new Map<string, Lease>();
	private config: ManagerConfig;
	private docker: DockerApi;
	private audit: Audit;
	private now: () => number;
	private sink: UsageSink;

	constructor(deps: {
		config: ManagerConfig;
		docker: DockerApi;
		audit: Audit;
		now?: () => number;
		usageSink?: UsageSink;
	}) {
		this.config = deps.config;
		this.docker = deps.docker;
		this.audit = deps.audit;
		this.now = deps.now ?? Date.now;
		this.sink = deps.usageSink ?? (() => {});
	}

	get active(): number {
		return this.leases.size;
	}

	get(id: string, owner?: string): Lease {
		const lease = this.leases.get(id);
		if (!lease || lease.state === "released" || (owner !== undefined && lease.owner !== owner)) {
			throw new HttpError(404, "no_such_lease", "no such lease");
		}
		return lease;
	}

	/** A request's limits on top of the defaults; anything above a maximum is refused, not clamped. */
	resolveLimits(requested: Partial<LeaseLimits> | undefined): LeaseLimits {
		const limits: LeaseLimits = { ...this.config.defaults };
		for (const key of Object.keys(limits) as (keyof LeaseLimits)[]) {
			const v = requested?.[key];
			if (v === undefined) continue;
			if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
				throw new HttpError(400, "bad_limit", `limits.${key} must be a positive number`);
			}
			if (v > this.config.maxima[key]) {
				throw new HttpError(
					400,
					"limit_exceeds_maximum",
					`limits.${key} may be at most ${this.config.maxima[key]}`
				);
			}
			limits[key] = v;
		}
		return limits;
	}

	async create(req: CreateRequest, actor = "service"): Promise<Lease> {
		if (req.kind === "machine") {
			this.audit.write({
				action: "lease.create",
				outcome: "denied",
				kind: "machine",
				owner: req.owner,
				actor,
				detail: { reason: "machines" },
			});
			if (!this.config.machinesEnabled) {
				throw new HttpError(
					403,
					"machines_disabled",
					"hosted machines are not enabled (SANDBOX_MACHINES_ENABLED)"
				);
			}
			throw new HttpError(
				501,
				"machines_not_implemented",
				"hosted machines are a later phase of ADR 0115"
			);
		}
		if (req.kind !== "exec")
			throw new HttpError(400, "bad_kind", 'kind must be "exec" or "machine"');
		if (typeof req.owner !== "string" || !OWNER_RE.test(req.owner)) {
			throw new HttpError(
				400,
				"bad_owner",
				"owner is 1-128 characters of letters, digits and _ . : @ -"
			);
		}
		if (req.conversation !== undefined && !OWNER_RE.test(req.conversation)) {
			throw new HttpError(
				400,
				"bad_conversation",
				"conversation has the same character rules as owner"
			);
		}
		const limits = this.resolveLimits(req.limits);

		const mine = [...this.leases.values()].filter((l) => l.owner === req.owner).length;
		if (this.leases.size >= this.config.maxLeases || mine >= this.config.maxLeasesPerOwner) {
			const which = mine >= this.config.maxLeasesPerOwner ? "owner" : "global";
			this.audit.write({
				action: "lease.create",
				outcome: "denied",
				kind: "exec",
				owner: req.owner,
				actor,
				detail: { reason: `quota_${which}` },
			});
			throw new HttpError(
				429,
				"quota_exceeded",
				`the ${which} limit on concurrent leases is reached`
			);
		}

		const id = randomBytes(12).toString("hex");
		const t = this.now();
		const lease: Lease = {
			id,
			kind: "exec",
			owner: req.owner,
			conversation: req.conversation ?? null,
			state: "creating",
			containerId: null,
			limits,
			createdAt: t,
			lastActiveAt: t,
			activeExecs: 0,
			usage: { execCalls: 0, execSeconds: 0, cpuSeconds: null },
		};
		this.leases.set(id, lease);
		try {
			await this.docker.ensureImage(this.config.execImage);
			lease.containerId = await this.docker.createContainer(
				containerName(id),
				execContainerSpec(this.config, lease, limits)
			);
			await this.docker.start(lease.containerId);
			lease.state = "ready";
			lease.lastActiveAt = this.now();
		} catch (err) {
			if (lease.containerId) await this.docker.remove(lease.containerId).catch(() => {});
			this.leases.delete(id);
			this.audit.write({
				action: "lease.create",
				outcome: "failure",
				lease: id,
				kind: "exec",
				owner: req.owner,
				actor,
				detail: { error: String(err).slice(0, 200) },
			});
			const hint = /runtime/i.test(String(err)) ? " (is the runtime registered with Docker?)" : "";
			throw new HttpError(503, "sandbox_start_failed", `could not start the sandbox${hint}`);
		}
		this.audit.write({
			action: "lease.create",
			outcome: "success",
			lease: id,
			kind: "exec",
			owner: req.owner,
			actor,
			detail: {
				conversation: req.conversation,
				memory_mb: limits.memoryMb,
				cpus: limits.cpus,
				pids: limits.pids,
				runtime: this.config.runtime,
			},
		});
		return lease;
	}

	/** Refuses to act on a container that is not labelled as this manager's lease. */
	private async guard(lease: Lease): Promise<string> {
		if (!lease.containerId) throw new HttpError(409, "not_ready", "the lease is not ready");
		const info = await this.docker.inspect(lease.containerId);
		if (!info) throw new HttpError(410, "sandbox_gone", "the sandbox no longer exists");
		const labels = info.Config?.Labels;
		if (!isManaged(labels, this.config.instance) || labels?.[LABEL_LEASE] !== lease.id) {
			this.audit.write({
				action: "guard",
				outcome: "denied",
				lease: lease.id,
				detail: { reason: "unlabelled_container" },
			});
			throw new HttpError(
				403,
				"not_managed",
				"that container is not one of this manager's sandboxes"
			);
		}
		return lease.containerId;
	}

	async release(id: string, reason = "released", actor = "service"): Promise<void> {
		const lease = this.get(id);
		await this.destroy(lease, reason, actor);
	}

	private async destroy(lease: Lease, reason: string, actor: string): Promise<void> {
		if (lease.state === "released") return;
		lease.state = "released";
		let cpu: number | null = null;
		if (lease.containerId) {
			try {
				const info = await this.docker.inspect(lease.containerId);
				if (info && isManaged(info.Config?.Labels, this.config.instance)) {
					cpu = await this.docker.cpuSeconds(lease.containerId);
					await this.docker.remove(lease.containerId);
				} else if (info) {
					this.audit.write({
						action: "guard",
						outcome: "denied",
						lease: lease.id,
						detail: { reason: "unlabelled_container" },
					});
				}
			} catch (err) {
				this.audit.write({
					action: "lease.release",
					outcome: "failure",
					lease: lease.id,
					kind: lease.kind,
					owner: lease.owner,
					actor,
					detail: { error: String(err).slice(0, 200) },
				});
			}
		}
		this.leases.delete(lease.id);
		lease.usage.cpuSeconds = cpu;
		const usage: UsageRecord = {
			lease: lease.id,
			owner: lease.owner,
			kind: lease.kind,
			wallSeconds: Math.round((this.now() - lease.createdAt) / 100) / 10,
			execSeconds: Math.round(lease.usage.execSeconds * 10) / 10,
			execCalls: lease.usage.execCalls,
			cpuSeconds: cpu === null ? null : Math.round(cpu * 100) / 100,
			reason,
		};
		this.audit.write({
			action: "lease.release",
			outcome: "success",
			lease: lease.id,
			kind: lease.kind,
			owner: lease.owner,
			actor,
			detail: {
				reason,
				wall_seconds: usage.wallSeconds,
				exec_seconds: usage.execSeconds,
				exec_calls: usage.execCalls,
				cpu_seconds: usage.cpuSeconds,
			},
		});
		try {
			this.sink(usage);
		} catch {
			/* the billing seam must never break a release */
		}
	}

	async exec(
		id: string,
		req: ExecRequest,
		owner?: string,
		actor = "service"
	): Promise<ExecResponse> {
		const lease = this.get(id, owner);
		if (lease.state !== "ready") throw new HttpError(409, "not_ready", "the lease is not ready");
		const argv = normaliseCommand(req);
		const timeout = req.timeoutSeconds ?? lease.limits.timeoutSeconds;
		if (
			typeof timeout !== "number" ||
			!(timeout > 0) ||
			timeout > this.config.maxima.execTimeoutSeconds
		) {
			throw new HttpError(
				400,
				"bad_timeout",
				`timeout_seconds must be in (0, ${this.config.maxima.execTimeoutSeconds}]`
			);
		}
		const maxOut = req.maxOutputBytes ?? lease.limits.maxOutputBytes;
		if (!(maxOut > 0) || maxOut > this.config.maxima.maxOutputBytes) {
			throw new HttpError(
				400,
				"bad_limit",
				`max_output_bytes may be at most ${this.config.maxima.maxOutputBytes}`
			);
		}
		const cwd = workspaceDir(req.cwd);
		const env = envList(req.env);
		const stdin = req.stdin === undefined ? undefined : Buffer.from(req.stdin, "utf8");
		if (stdin && stdin.length > this.config.maxFileBytes) {
			throw new HttpError(413, "body_too_large", "stdin is too large");
		}
		const result = await this.run(
			lease,
			{
				cmd: ["timeout", "-s", "KILL", String(timeout), ...argv],
				workingDir: cwd,
				env,
				stdin,
				maxOutputBytes: maxOut,
				timeoutMs: timeout * 1000 + 5000,
			},
			actor,
			{
				cmdBytes: argv.join(" ").length,
				cmdHash: createHash("sha256").update(JSON.stringify(argv)).digest("hex").slice(0, 12),
			}
		);
		const timedOut =
			result.timedOut || (result.exitCode === 137 && result.durationMs >= timeout * 1000 - 200);
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString("utf8"),
			stderr: result.stderr.toString("utf8"),
			truncated: result.truncated,
			timedOut,
			durationMs: result.durationMs,
		};
	}

	/** One bounded exec in the container, with the per-lease concurrency cap and accounting. */
	private async run(
		lease: Lease,
		opts: {
			cmd: string[];
			workingDir?: string;
			env?: string[];
			stdin?: Buffer;
			maxOutputBytes: number;
			timeoutMs: number;
		},
		actor: string,
		meta: Record<string, unknown>
	): Promise<ExecResult> {
		if (lease.activeExecs >= this.config.maxConcurrentExecsPerLease) {
			throw new HttpError(429, "busy", "too many calls at once on this lease");
		}
		const containerId = await this.guard(lease);
		lease.activeExecs++;
		let result: ExecResult;
		try {
			result = await this.docker.exec(containerId, { ...opts, user: this.config.user });
		} catch (err) {
			this.audit.write({
				action: "lease.exec",
				outcome: "failure",
				lease: lease.id,
				kind: lease.kind,
				owner: lease.owner,
				actor,
				detail: { ...meta, error: String(err).slice(0, 200) },
			});
			if (err instanceof DockerError && err.status === 409) {
				throw new HttpError(410, "sandbox_gone", "the sandbox is no longer running");
			}
			throw new HttpError(502, "docker_error", "the container runtime failed the call");
		} finally {
			lease.activeExecs--;
			lease.lastActiveAt = this.now();
		}
		lease.usage.execCalls++;
		lease.usage.execSeconds += result.durationMs / 1000;
		this.audit.write({
			action: "lease.exec",
			outcome: "success",
			lease: lease.id,
			kind: lease.kind,
			owner: lease.owner,
			actor,
			detail: {
				...meta,
				exit_code: result.exitCode,
				duration_ms: result.durationMs,
				out_bytes: result.stdout.length + result.stderr.length,
				truncated: result.truncated,
				timed_out: result.timedOut,
			},
		});
		if (result.stillRunning) {
			// A command that outlived its own timeout (or whose output was cut) is not trusted to
			// stop: the sandbox is destroyed, and the next call gets 404.
			await this.destroy(lease, "runaway_exec", actor);
		}
		return result;
	}

	async putFile(
		id: string,
		rawPath: string,
		data: Buffer,
		owner?: string,
		actor = "service"
	): Promise<void> {
		const lease = this.get(id, owner);
		if (lease.state !== "ready") throw new HttpError(409, "not_ready", "the lease is not ready");
		if (data.length > this.config.maxFileBytes) {
			throw new HttpError(
				413,
				"file_too_large",
				`a file may be at most ${this.config.maxFileBytes} bytes`
			);
		}
		const path = workspacePath(rawPath);
		const script = [
			'd=$(dirname -- "$1")',
			'mkdir -p -- "$d" || exit 5',
			'r=$(readlink -f -- "$d") || exit 5',
			'case "$r" in /workspace|/workspace/*) ;; *) exit 3;; esac',
			'if [ -e "$1" ] || [ -L "$1" ]; then t=$(readlink -f -- "$1") || exit 5; case "$t" in /workspace/*) ;; *) exit 3;; esac; [ -d "$t" ] && exit 6; fi',
			'cat > "$1"',
		].join("; ");
		const result = await this.run(
			lease,
			{
				cmd: ["timeout", "-s", "KILL", "30", "sh", "-c", script, "sh", path],
				workingDir: WORKSPACE,
				stdin: data,
				maxOutputBytes: 4096,
				timeoutMs: 35_000,
			},
			actor,
			{ op: "put_file", bytes: data.length }
		);
		if (result.exitCode === 3)
			throw new HttpError(400, "bad_path", "the path leaves the workspace");
		if (result.exitCode === 6) throw new HttpError(400, "bad_path", "the path is a directory");
		if (result.exitCode !== 0)
			throw new HttpError(500, "write_failed", "the file could not be written (workspace full?)");
	}

	async getFile(id: string, rawPath: string, owner?: string, actor = "service"): Promise<Buffer> {
		const lease = this.get(id, owner);
		if (lease.state !== "ready") throw new HttpError(409, "not_ready", "the lease is not ready");
		const path = workspacePath(rawPath);
		const script = [
			'r=$(readlink -f -- "$1") || exit 4',
			'case "$r" in /workspace/*) ;; *) exit 3;; esac',
			'[ -f "$r" ] || exit 4',
			'cat -- "$r"',
		].join("; ");
		const limit = this.config.maxFileBytes;
		const result = await this.run(
			lease,
			{
				cmd: ["timeout", "-s", "KILL", "30", "sh", "-c", script, "sh", path],
				workingDir: WORKSPACE,
				maxOutputBytes: limit + 1,
				timeoutMs: 35_000,
			},
			actor,
			{ op: "get_file" }
		);
		if (result.truncated || result.stdout.length > limit) {
			throw new HttpError(413, "file_too_large", `a file may be at most ${limit} bytes`);
		}
		if (result.exitCode === 4) throw new HttpError(404, "no_such_file", "no such file");
		if (result.exitCode === 3)
			throw new HttpError(400, "bad_path", "the path leaves the workspace");
		if (result.exitCode !== 0)
			throw new HttpError(500, "read_failed", "the file could not be read");
		return result.stdout;
	}

	/** Releases leases idle past their timeout, or older than the maximum lifetime. */
	async reap(): Promise<number> {
		const t = this.now();
		let n = 0;
		for (const lease of [...this.leases.values()]) {
			if (lease.state !== "ready") continue;
			const idle =
				lease.activeExecs === 0 && t - lease.lastActiveAt > lease.limits.idleSeconds * 1000;
			const old = t - lease.createdAt > this.config.maxima.lifetimeSeconds * 1000;
			if (idle || old) {
				await this.destroy(lease, idle ? "idle" : "max_lifetime", "reaper");
				n++;
			}
		}
		return n;
	}

	/** On start: remove every labelled container of this instance left by a previous run. */
	async sweepOrphans(): Promise<number> {
		const found = await this.docker.listManaged([
			`${LABEL_MANAGED}=1`,
			`${LABEL_INSTANCE}=${this.config.instance}`,
		]);
		let n = 0;
		for (const c of found) {
			if (!isManaged(c.Config?.Labels, this.config.instance)) continue;
			await this.docker.remove(c.Id).catch(() => {});
			n++;
			this.audit.write({
				action: "orphan.remove",
				outcome: "success",
				lease: c.Config?.Labels?.[LABEL_LEASE],
				actor: "startup",
			});
		}
		return n;
	}

	async shutdown(): Promise<void> {
		for (const lease of [...this.leases.values()])
			await this.destroy(lease, "shutdown", "shutdown");
	}

	view(lease: Lease) {
		const t = this.now();
		return {
			id: lease.id,
			kind: lease.kind,
			owner: lease.owner,
			conversation: lease.conversation,
			state: lease.state,
			created_at: new Date(lease.createdAt).toISOString(),
			last_active_at: new Date(lease.lastActiveAt).toISOString(),
			idle_expires_at: new Date(lease.lastActiveAt + lease.limits.idleSeconds * 1000).toISOString(),
			limits: {
				memory_mb: lease.limits.memoryMb,
				cpus: lease.limits.cpus,
				pids: lease.limits.pids,
				workspace_mb: lease.limits.workspaceMb,
				timeout_seconds: lease.limits.timeoutSeconds,
				max_output_bytes: lease.limits.maxOutputBytes,
				idle_seconds: lease.limits.idleSeconds,
			},
			usage: {
				exec_calls: lease.usage.execCalls,
				exec_seconds: Math.round(lease.usage.execSeconds * 10) / 10,
				wall_seconds: Math.round((t - lease.createdAt) / 100) / 10,
			},
		};
	}
}

function normaliseCommand(req: ExecRequest): string[] {
	const hasCmd = req.cmd !== undefined;
	const hasCommand = req.command !== undefined;
	if (hasCmd === hasCommand) {
		throw new HttpError(
			400,
			"bad_command",
			"give exactly one of cmd (an argument list) or command (a shell string)"
		);
	}
	if (hasCommand) {
		if (typeof req.command !== "string" || !req.command || req.command.length > 200_000) {
			throw new HttpError(
				400,
				"bad_command",
				"command must be a non-empty string under 200000 characters"
			);
		}
		return ["sh", "-c", req.command];
	}
	const cmd = req.cmd;
	if (
		!Array.isArray(cmd) ||
		cmd.length === 0 ||
		cmd.length > 256 ||
		cmd.some((a) => typeof a !== "string" || a.length > 200_000)
	) {
		throw new HttpError(400, "bad_command", "cmd must be a non-empty list of strings");
	}
	return cmd;
}

function envList(env: Record<string, string> | undefined): string[] | undefined {
	if (env === undefined) return undefined;
	const entries = Object.entries(env);
	if (entries.length > 32) throw new HttpError(400, "bad_env", "at most 32 environment variables");
	return entries.map(([k, v]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || typeof v !== "string" || v.length > 8192) {
			throw new HttpError(400, "bad_env", "an environment variable has a bad name or value");
		}
		return `${k}=${v}`;
	});
}
