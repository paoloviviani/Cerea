/**
 * The e2e process sweeper kills by run directory, never by name — this pins
 * that contract: a process marked with a stale run dir dies (by command
 * line AND by environment), while an unmarked sibling, this process
 * itself, and everything else on the box live.
 *
 * Linux only (`/proc`), like the sweeper. Spawns real `sleep` processes;
 * nothing here touches galopin or opencode.
 */
import { describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processAlive, stopTree, sweepStaleRunProcesses } from "../../../tests/e2eProc.ts";

const sleepy = (env: NodeJS.ProcessEnv = {}) =>
	spawn("sleep", ["300"], { env: { ...process.env, ...env }, stdio: "ignore" });

const isDead = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

describe("sweepStaleRunProcesses", () => {
	it("kills processes marked by a stale run dir, by cmdline and by env, and spares the rest", async () => {
		const root = mkdtempSync(join(tmpdir(), "e2eproc-"));
		// 2^22 never runs here: the run dir reads as stale.
		const stale = join(root, "run-4194304");
		mkdirSync(join(stale, "home"), { recursive: true });
		try {
			// node keeps its full argv (bash would exec and drop it).
			const byCmdline = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", stale], {
				stdio: "ignore",
			});
			const byEnv = sleepy({ HOME: join(stale, "home") });
			const clean = sleepy();
			await new Promise((resolve) => setTimeout(resolve, 200));
			const { killed } = sweepStaleRunProcesses(root);
			expect(killed).toBe(2);
			for (const child of [byCmdline, byEnv]) {
				for (let i = 0; i < 50 && !isDead(child); i++) {
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				expect(isDead(child)).toBe(true);
			}
			expect(isDead(clean)).toBe(false);
			expect(processAlive(process.pid)).toBe(true);
			clean.kill("SIGKILL");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("stopTree kills a detached child and its subtree", async () => {
		const leader = spawn("bash", ["-c", "sleep 300 & wait"], {
			detached: true,
			stdio: "ignore",
		});
		const grandchild = await new Promise<number>((resolve) => {
			const poll = setInterval(() => {
				try {
					const out = execFileSync("pgrep", ["-P", String(leader.pid)])
						.toString()
						.trim();
					if (out) {
						clearInterval(poll);
						resolve(Number(out.split("\n")[0]));
					}
				} catch {
					// Not reaped yet; poll again.
				}
			}, 100);
			setTimeout(() => {
				clearInterval(poll);
				resolve(-1);
			}, 5000);
		});
		expect(grandchild).toBeGreaterThan(0);
		await stopTree(leader, 2000);
		expect(isDead(leader)).toBe(true);
		if (grandchild > 0) {
			// Killed is not the same instant as gone: an orphaned child is reaped
			// by whoever adopted it, which on a CI runner can take a moment, and
			// a zombie still answers kill(pid, 0). Gone, or a zombie, within 2s.
			const gone = () => {
				try {
					process.kill(grandchild, 0);
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
					throw err;
				}
				try {
					return readFileSync(`/proc/${grandchild}/stat`, "utf8").split(") ")[1]?.startsWith("Z");
				} catch {
					return true;
				}
			};
			await expect.poll(gone, { timeout: 2000, interval: 50 }).toBe(true);
		}
	});
});
