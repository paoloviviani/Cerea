/**
 * The galopin sidecar: finding it, running one-shot commands, supervising `galopin run`.
 * Everything runs the binary the app ships (or `GALOPIN_BIN`), with arguments built in
 * `galopinArgs.ts`; output is streamed line by line to the UI.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { delimiter, join } from "node:path";
import { galopinConfigDir, terminalCommand } from "./galopinArgs.ts";

export function findGalopin(opts: {
	resources?: string;
	devRoot: string;
	env?: NodeJS.ProcessEnv;
	/** A packaged app runs only the galopin it ships: no environment variable can swap in another. */
	packaged?: boolean;
}): string | undefined {
	const env = opts.env ?? process.env;
	const candidates = [
		opts.packaged ? undefined : env.GALOPIN_BIN,
		opts.resources && join(opts.resources, "galopin", "galopin"),
		join(opts.devRoot, "resources", "galopin", "galopin"),
	].filter((p): p is string => !!p);
	return candidates.find((p) => existsSync(p));
}

export interface RunResult {
	code: number | null;
	output: string;
}

export class Galopin {
	private run?: ChildProcess;
	private wantRunning = false;
	private strikes = 0;
	private startedAt = 0;

	constructor(
		readonly bin: string | undefined,
		private readonly onLine: (line: string) => void,
		private env: NodeJS.ProcessEnv = process.env,
		private readonly onChange: () => void = () => {}
	) {}

	get available(): boolean {
		return !!this.bin;
	}

	/** Run every later galopin command with this directory first on PATH (the app's own Node). */
	useNode(binDir: string): void {
		this.env = { ...this.env, PATH: `${binDir}${delimiter}${this.env.PATH ?? ""}` };
	}

	configDir(): string {
		return galopinConfigDir(this.env);
	}
	credentialsFile(): string {
		return join(this.configDir(), "credentials.json");
	}
	paired(): boolean {
		return existsSync(this.credentialsFile());
	}
	/** The address this computer is paired with, as galopin recorded it (empty when unknown). */
	pairedAddress(): string {
		try {
			const c = JSON.parse(readFileSync(this.credentialsFile(), "utf8")) as {
				cerea_origin?: unknown;
			};
			return typeof c.cerea_origin === "string" ? c.cerea_origin : "";
		} catch {
			return "";
		}
	}
	/** Forget the pairing on this computer: the credentials are kept aside, not deleted. */
	unpairLocal(): string | undefined {
		if (!this.paired()) return undefined;
		const to = `${this.credentialsFile()}.unpaired-${Date.now()}`;
		renameSync(this.credentialsFile(), to);
		return to;
	}

	/** Run a command to the end, streaming its lines. */
	exec(args: string[]): Promise<RunResult> {
		return new Promise((resolve) => {
			if (!this.bin)
				return resolve({ code: null, output: "galopin is not installed with this app." });
			this.onLine(`$ galopin ${args.join(" ")}`);
			const child = spawn(this.bin, args, { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			const feed = (b: Buffer) => {
				const text = b.toString();
				output += text;
				for (const l of text.split(/\r?\n/)) if (l) this.onLine(l);
			};
			child.stdout.on("data", feed);
			child.stderr.on("data", feed);
			child.on("error", (e) => resolve({ code: null, output: String(e) }));
			child.on("close", (code) => resolve({ code, output }));
		});
	}

	get running(): boolean {
		return !!this.run && this.run.exitCode === null;
	}

	/** Keep `galopin run` going: restarted when it stops, unless it fails at once three times. */
	start(): void {
		if (!this.bin || this.running) return;
		this.wantRunning = true;
		this.strikes = 0;
		this.spawnRun();
	}

	private spawnRun(): void {
		if (!this.bin || !this.wantRunning) return;
		this.startedAt = Date.now();
		this.onLine("$ galopin run");
		const child = spawn(this.bin, ["run"], { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
		this.run = child;
		this.onChange();
		const feed = (b: Buffer) => {
			for (const l of b.toString().split(/\r?\n/)) if (l) this.onLine(l);
		};
		child.stdout.on("data", feed);
		child.stderr.on("data", feed);
		child.on("close", (code) => {
			if (this.run === child) this.run = undefined;
			this.onChange();
			if (!this.wantRunning) return;
			this.strikes = Date.now() - this.startedAt < 5000 ? this.strikes + 1 : 0;
			if (this.strikes >= 3) {
				this.wantRunning = false;
				this.onLine(
					`galopin run stopped at once ${this.strikes} times (exit ${code}); not restarting.`
				);
				return;
			}
			setTimeout(() => this.spawnRun(), 2000 * (this.strikes + 1)).unref();
		});
	}

	/** Stops `galopin run` and resolves when the process has exited (killed after 5 s). */
	stop(): Promise<void> {
		this.wantRunning = false;
		const child = this.run;
		if (!child || child.exitCode !== null) return Promise.resolve();
		return new Promise((resolve) => {
			const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
			child.once("close", () => {
				clearTimeout(kill);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}

	/** Whether a galopin service (systemd user unit, LaunchAgent) is installed for this user. */
	serviceInstalled(home = process.env.HOME ?? "", xdg = process.env.XDG_CONFIG_HOME): boolean {
		return (
			existsSync(join(xdg || join(home, ".config"), "systemd", "user", "galopin.service")) ||
			existsSync(join(home, "Library", "LaunchAgents", "org.cerea.galopin.plist"))
		);
	}

	/** A tool in a terminal window: interactive, so it needs a real terminal and not a pipe. */
	launchInTerminal(argv: string[], cwd: string): { ok: boolean; message: string } {
		if (!this.bin) return { ok: false, message: "galopin is not installed with this app." };
		const path = (this.env.PATH ?? "").split(delimiter);
		const exists = (b: string) => path.some((d) => existsSync(join(d, b)));
		const t = terminalCommand(process.platform, [this.bin, ...argv], cwd, exists);
		if (!t)
			return {
				ok: false,
				message: `No terminal program found. Run in a terminal: galopin ${argv.join(" ")}`,
			};
		const child = spawn(t.command, t.args, { env: this.env, stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
		return { ok: true, message: `Opened ${argv.join(" ")} in a terminal.` };
	}
}
