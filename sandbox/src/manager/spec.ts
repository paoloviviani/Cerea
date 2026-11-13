import type { ManagerConfig, LeaseLimits } from "./config.ts";
import {
	LABEL_INSTANCE,
	LABEL_KIND,
	LABEL_LEASE,
	LABEL_MANAGED,
	LABEL_OWNER,
	NAME_PREFIX,
} from "../shared/labels.ts";
import { WORKSPACE } from "./paths.ts";

export function containerName(leaseId: string): string {
	return `${NAME_PREFIX}${leaseId}`;
}

/**
 * The Docker create body of an `exec` sandbox. The hardening is all here and the socket proxy
 * re-checks it (a manager that is compromised or has a bug still cannot ask for less):
 * - the runtime (gVisor `runsc` by default), a non-root user, a read-only root file system;
 * - a small tmpfs workspace and /tmp, no volumes, no bind mounts, nothing from the host;
 * - every capability dropped, no-new-privileges, no swap, memory, CPU and pid limits;
 * - no network at all.
 */
export function execContainerSpec(
	config: ManagerConfig,
	lease: { id: string; owner: string; kind: string },
	limits: LeaseLimits
): Record<string, unknown> {
	const [uid, gid] = config.user.split(":");
	const tmpOpts = (mb: number, mode: string, exec: boolean) =>
		`rw,nosuid,nodev,${exec ? "exec" : "noexec"},size=${mb}m,uid=${uid},gid=${gid ?? uid},mode=${mode}`;
	return {
		Image: config.execImage,
		Entrypoint: ["sleep", "infinity"],
		Cmd: [],
		User: config.user,
		WorkingDir: WORKSPACE,
		Env: [
			`HOME=${WORKSPACE}`,
			"TMPDIR=/tmp",
			"PYTHONDONTWRITEBYTECODE=1",
			"PYTHONUNBUFFERED=1",
			"MPLCONFIGDIR=/tmp/mpl",
		],
		Labels: {
			[LABEL_MANAGED]: "1",
			[LABEL_INSTANCE]: config.instance,
			[LABEL_LEASE]: lease.id,
			[LABEL_OWNER]: lease.owner,
			[LABEL_KIND]: lease.kind,
		},
		StopTimeout: 2,
		HostConfig: {
			Runtime: config.runtime,
			NetworkMode: "none",
			ReadonlyRootfs: true,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
			Privileged: false,
			Init: true,
			IpcMode: "private",
			Memory: limits.memoryMb * 1024 * 1024,
			MemorySwap: limits.memoryMb * 1024 * 1024,
			NanoCpus: Math.round(limits.cpus * 1e9),
			PidsLimit: limits.pids,
			Tmpfs: {
				[WORKSPACE]: tmpOpts(limits.workspaceMb, "0700", true),
				"/tmp": tmpOpts(64, "1777", false),
			},
			Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 1024 }],
		},
	};
}
