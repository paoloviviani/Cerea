/**
 * The manager's settings, all from the environment. Every number has a default sized for a small
 * box (see docs/sandboxes.md, "Sizing") and a maximum a request may not pass.
 */
export const DEFAULT_EXEC_IMAGE =
	"python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90";

export interface LeaseLimits {
	memoryMb: number;
	cpus: number;
	pids: number;
	workspaceMb: number;
	/** Default wall-time cap of one exec call. */
	timeoutSeconds: number;
	/** stdout + stderr of one exec call; more is cut and the call is marked truncated. */
	maxOutputBytes: number;
	/** A lease with no call for this long is released. */
	idleSeconds: number;
}

export interface ManagerConfig {
	token: string;
	host: string;
	port: number;
	docker: { url?: string; socketPath?: string };
	instance: string;
	runtime: string;
	allowRunc: boolean;
	machinesEnabled: boolean;
	execImage: string;
	user: string;
	defaults: LeaseLimits;
	maxima: LeaseLimits & { lifetimeSeconds: number; execTimeoutSeconds: number };
	maxLeases: number;
	maxLeasesPerOwner: number;
	warmPoolSize: number;
	maxFileBytes: number;
	maxConcurrentExecsPerLease: number;
	/** Requests in flight at once, all routes; more get 503 before their body is read. */
	maxInflight: number;
	/** File transfers in flight at once (each buffers up to maxFileBytes several times over). */
	maxFileTransfers: number;
	reapIntervalSeconds: number;
	auditLog: string;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number, min = 1): number {
	const raw = env[key];
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < min) throw new Error(`${key} must be a number >= ${min}`);
	return n;
}

function flag(env: Env, key: string): boolean {
	return (env[key] ?? "").trim().toLowerCase() === "true";
}

export class ConfigError extends Error {}

export function loadConfig(env: Env = process.env): ManagerConfig {
	const token = env.SANDBOX_MANAGER_TOKEN ?? "";
	if (token.length < 16) {
		throw new ConfigError(
			"SANDBOX_MANAGER_TOKEN is empty or shorter than 16 characters: the manager never starts without a service token"
		);
	}
	const runtime = (env.SANDBOX_RUNTIME || "runsc").trim();
	const allowRunc = flag(env, "SANDBOX_ALLOW_RUNC");
	if (runtime !== "runsc" && !(runtime === "runc" && allowRunc)) {
		throw new ConfigError(
			`SANDBOX_RUNTIME=${runtime} is refused: only runsc (gVisor), or runc with SANDBOX_ALLOW_RUNC=true (development and tests only)`
		);
	}
	const defaults: LeaseLimits = {
		memoryMb: num(env, "SANDBOX_EXEC_MEMORY_MB", 512),
		cpus: num(env, "SANDBOX_EXEC_CPUS", 1, 0.1),
		pids: num(env, "SANDBOX_EXEC_PIDS", 256),
		workspaceMb: num(env, "SANDBOX_EXEC_WORKSPACE_MB", 256),
		timeoutSeconds: num(env, "SANDBOX_EXEC_TIMEOUT_SECONDS", 30),
		maxOutputBytes: num(env, "SANDBOX_EXEC_MAX_OUTPUT_BYTES", 262_144),
		idleSeconds: num(env, "SANDBOX_IDLE_SECONDS", 1200),
	};
	const maxima = {
		memoryMb: num(env, "SANDBOX_EXEC_MAX_MEMORY_MB", 2048),
		cpus: num(env, "SANDBOX_EXEC_MAX_CPUS", 2, 0.1),
		pids: num(env, "SANDBOX_EXEC_MAX_PIDS", 1024),
		workspaceMb: num(env, "SANDBOX_EXEC_MAX_WORKSPACE_MB", 1024),
		timeoutSeconds: num(env, "SANDBOX_EXEC_MAX_TIMEOUT_SECONDS", 300),
		execTimeoutSeconds: num(env, "SANDBOX_EXEC_MAX_TIMEOUT_SECONDS", 300),
		maxOutputBytes: num(env, "SANDBOX_EXEC_MAX_OUTPUT_BYTES_CAP", 1_048_576),
		idleSeconds: num(env, "SANDBOX_MAX_IDLE_SECONDS", 3600),
		lifetimeSeconds: num(env, "SANDBOX_MAX_LIFETIME_SECONDS", 14_400),
	};
	for (const k of Object.keys(defaults) as (keyof LeaseLimits)[]) {
		if (defaults[k] > maxima[k]) {
			throw new ConfigError(
				`the default for ${k} is above its maximum: lower it or raise the maximum`
			);
		}
	}
	const dockerUrl = env.SANDBOX_DOCKER_URL || "http://sandbox-socket-proxy:2375";
	return {
		token,
		host: env.SANDBOX_MANAGER_HOST || "0.0.0.0",
		port: num(env, "SANDBOX_MANAGER_PORT", 8080),
		docker: env.SANDBOX_DOCKER_SOCKET
			? { socketPath: env.SANDBOX_DOCKER_SOCKET }
			: { url: dockerUrl },
		instance: (env.SANDBOX_INSTANCE || "cerea").trim(),
		runtime,
		allowRunc,
		machinesEnabled: flag(env, "SANDBOX_MACHINES_ENABLED"),
		execImage: (env.SANDBOX_EXEC_IMAGE || DEFAULT_EXEC_IMAGE).trim(),
		user: env.SANDBOX_USER || "65534:65534",
		defaults,
		maxima,
		maxLeases: num(env, "SANDBOX_MAX_LEASES", 4),
		maxLeasesPerOwner: num(env, "SANDBOX_MAX_LEASES_PER_OWNER", 2),
		warmPoolSize: num(env, "SANDBOX_WARM_POOL_SIZE", 0, 0),
		maxFileBytes: num(env, "SANDBOX_MAX_FILE_BYTES", 8_388_608),
		maxConcurrentExecsPerLease: num(env, "SANDBOX_MAX_CONCURRENT_EXECS", 4),
		maxInflight: num(env, "SANDBOX_MAX_INFLIGHT", 16),
		maxFileTransfers: num(env, "SANDBOX_MAX_FILE_TRANSFERS", 4),
		reapIntervalSeconds: num(env, "SANDBOX_REAP_INTERVAL_SECONDS", 15),
		auditLog: env.SANDBOX_AUDIT_LOG ?? "/var/lib/sandbox/audit.jsonl",
	};
}
