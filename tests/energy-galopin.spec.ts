/**
 * galopin idle measurement (only with `ENERGY=1`, like `energy-idle.spec.ts`).
 *
 * Starts the real machine from the harness, pairs it, then samples /proc for
 * galopin and every descendant (opencode) while nothing happens for
 * `GALOPIN_SECONDS` (default 300): CPU ticks (utime+stime), voluntary and
 * involuntary context switches (wakeups) and thread count. Appends one JSON
 * line to `$ENERGY_OUT`. Linux only. Recipe: docs/dev/energy.md.
 */
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect, E2E_APP_BASE } from "./fixtures";
import { opencodeAvailable, seedUser, startMachine } from "./machineHarness";

const SECONDS = Number(process.env.GALOPIN_SECONDS ?? 300);
const OUT = process.env.ENERGY_OUT ?? "/var/tmp/energy-tmp/results.jsonl";
const LABEL = process.env.ENERGY_LABEL ?? "run";

test.skip(process.env.ENERGY !== "1" || process.platform !== "linux", "set ENERGY=1 (Linux)");
test.skip(!opencodeAvailable(), "needs the opencode binary on PATH");

interface Sample {
	ticks: number;
	procs: Record<string, { ticks: number; tids: Record<string, number> }>;
}

function procs(): { pid: number; ppid: number; comm: string; cmd: string }[] {
	const out = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = readFileSync(`/proc/${name}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			const comm = stat.slice(stat.indexOf("(") + 1, close);
			const ppid = Number(stat.slice(close + 2).split(" ")[1]);
			const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ");
			out.push({ pid: Number(name), ppid, comm, cmd });
		} catch {
			/* gone */
		}
	}
	return out;
}

function sample(rootDir: string): Sample {
	const all = procs();
	const root = all.find((p) => p.cmd.includes(" run ") && p.cmd.includes(rootDir));
	if (!root) throw new Error("galopin process not found");
	const tree = new Set([root.pid]);
	for (let grew = true; grew;) {
		grew = false;
		for (const p of all) if (tree.has(p.ppid) && !tree.has(p.pid)) (tree.add(p.pid), (grew = true));
	}
	const s: Sample = { ticks: 0, procs: {} };
	for (const pid of tree) {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const ticks = Number(f[11]) + Number(f[12]);
			// Context switches are per thread, and Go starts and retires threads: keep
			// them per tid so the delta only compares threads alive at both samples.
			const tids: Record<string, number> = {};
			for (const tid of readdirSync(`/proc/${pid}/task`)) {
				try {
					const status = readFileSync(`/proc/${pid}/task/${tid}/status`, "utf8");
					tids[tid] =
						Number(/voluntary_ctxt_switches:\s+(\d+)/.exec(status)?.[1] ?? 0) +
						Number(/nonvoluntary_ctxt_switches:\s+(\d+)/.exec(status)?.[1] ?? 0);
				} catch {
					/* thread gone */
				}
			}
			const comm = all.find((p) => p.pid === pid)?.comm ?? String(pid);
			s.ticks += ticks;
			s.procs[`${comm}:${pid}`] = { ticks, tids };
		} catch {
			/* exited */
		}
	}
	return s;
}

test("galopin idle", async ({ page, db, session }) => {
	test.setTimeout((SECONDS + 240) * 1000);
	const sub = `e2e-${randomUUID()}`;
	await seedUser(db, session.sessionId, sub);
	const machine = await startMachine({ sub });
	try {
		await page.goto(`${E2E_APP_BASE}/code`);
		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.getByText(machine.name)).toBeVisible({ timeout: 60_000 });
		await page.getByRole("button", { name: "Confirm this computer" }).click();
		await page.getByRole("button", { name: "Add a workspace to this computer" }).click();
		await page.getByLabel("Directory on the computer").fill(machine.workspace);
		await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
		await expect(page.getByRole("link", { name: /^repo|workspace/i }).first()).toBeVisible();
		// Nobody is looking: close the page so no viewer or poll reaches the machine.
		await page.close();
		await new Promise((r) => setTimeout(r, 20_000));
		const a = sample(machine.root);
		await new Promise((r) => setTimeout(r, SECONDS * 1000));
		const b = sample(machine.root);
		const hz = 100;
		const per = (n: number) => +((n * 60) / SECONDS).toFixed(1);
		const perProc: Record<string, unknown> = {};
		let wakeups = 0;
		for (const [k, v] of Object.entries(b.procs)) {
			const u = a.procs[k];
			if (!u) continue;
			let n = 0;
			for (const [tid, count] of Object.entries(v.tids))
				if (tid in u.tids) n += count - u.tids[tid];
			wakeups += n;
			perProc[k] = {
				cpuMsPerMin: per(((v.ticks - u.ticks) * 1000) / hz),
				wakeupsPerMin: per(n),
			};
		}
		appendFileSync(
			OUT,
			JSON.stringify({
				label: LABEL,
				surface: "galopin",
				seconds: SECONDS,
				cpuMsPerMin: per(((b.ticks - a.ticks) * 1000) / hz),
				wakeupsPerMin: per(wakeups),
				procs: perProc,
			}) + "\n"
		);
	} finally {
		await machine.stop();
	}
});
