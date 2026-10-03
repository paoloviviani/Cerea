/**
 * Process hygiene for the /code e2e harness (`tests/machineHarness.ts`).
 *
 * A harness galopin supervises a real `opencode serve`, and killing only the
 * galopin orphans the opencode child — which then spins on this box
 * indefinitely (one such orphan ate a CPU for hours before anyone noticed).
 * So galopin is spawned detached (its own process group) and stopped by
 * group, and each worker sweeps processes left behind by dead runs.
 *
 * Matching is by run directory ONLY (`~/.cache/galopin-e2e/run-<pid>/`,
 * present in the galopin command line as `--state-dir` and in its
 * children's environment as `HOME`/`XDG_*`/`TMPDIR`), never by process
 * name: an `opencode serve` that is not under a stale run dir — including
 * the one running this very session — is never touched.
 */
import { type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Stop a detached child and its whole process tree: SIGTERM to the group,
 * then SIGKILL after `graceMs` if anything is still alive. Only call this
 * on children spawned with `detached: true` (whose group id is their own
 * pid) — killing a non-detached child's "group" would hit this process's
 * own group instead.
 */
export async function stopTree(child: ChildProcess, graceMs = 5000): Promise<void> {
	const pgid = child.pid;
	if (pgid === undefined || pgid <= 1 || child.exitCode !== null) return;
	const killGroup = (signal: NodeJS.Signals) => {
		try {
			process.kill(-pgid, signal);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
		}
	};
	killGroup("SIGTERM");
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	const winner = await Promise.race([
		exited.then((): "exited" | "timeout" => "exited"),
		sleep(graceMs).then((): "exited" | "timeout" => "timeout"),
	]);
	if (winner === "timeout") killGroup("SIGKILL");
	await exited;
}

/**
 * SIGKILL leftover test processes from dead runs. For every
 * `run-<pid>` dir under `cacheRoot` whose worker pid is dead, kills every
 * process whose command line mentions that dir, or whose `HOME`/`XDG_*`/
 * `TMPDIR` environment points under it. Linux only; elsewhere a no-op.
 * Skips our own pid and pid 1, and unreadable /proc entries (other users'
 * processes, which we couldn't signal anyway). Returns the kill count.
 */
export function sweepStaleRunProcesses(cacheRoot: string): { killed: number } {
	if (process.platform !== "linux") return { killed: 0 };
	let names: string[] = [];
	try {
		names = readdirSync(cacheRoot);
	} catch {
		return { killed: 0 };
	}
	const staleDirs: string[] = [];
	for (const name of names) {
		const pid = /^run-(\d+)$/.exec(name)?.[1];
		if (pid && !processAlive(Number(pid))) staleDirs.push(join(cacheRoot, name));
	}
	if (staleDirs.length === 0) return { killed: 0 };
	const watchedEnv = /^(HOME|XDG_CACHE_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME|TMPDIR)=/;
	let killed = 0;
	const self = process.pid;
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === self || pid === 1) continue;
		let haystack: string;
		try {
			const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
			const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
			const envHits = environ
				.split("\0")
				.filter((line) => watchedEnv.test(line))
				.join("\0");
			haystack = `${cmdline}\0${envHits}`;
		} catch {
			continue;
		}
		if (!staleDirs.some((dir) => haystack.includes(dir))) continue;
		try {
			process.kill(pid, "SIGKILL");
			killed++;
		} catch {
			// Raced its exit; nothing to do.
		}
	}
	return { killed };
}
