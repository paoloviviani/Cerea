/**
 * What the app asks galopin to do, as argument lists. Pure, so they are tested without a galopin:
 * the renderer can only pick from the shapes in `shared/ipc.ts`, and this is the one place those
 * become a command line (never a shell string: no shell is involved except the terminal handoff,
 * whose pieces are quoted here).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { PairOptions, Tool } from "../shared/ipc.ts";

export function enrollArgs(address: string, o: PairOptions): string[] {
	const a = ["enroll", "--cerea", address];
	if (!o.agent) a.push("--connectors-only");
	if (o.flow === "device") a.push("--device");
	if (o.flow === "loopback") a.push("--loopback");
	if (o.agent) {
		if (o.engine && o.engine !== "opencode") a.push("--engine", o.engine);
		if (o.defaultGroup) a.push("--default-group");
		else if (o.group) a.push("--group", o.group);
		if (o.noTerminal) a.push("--no-terminal");
		if (o.noFiles) a.push("--no-files");
		if (o.allowFileWrite) a.push("--allow-file-write");
		if (o.allowProjectConfig) a.push("--allow-project-config");
		for (const r of o.workspaceRoots ?? []) a.push("--workspace-root", expandHome(r));
		for (const d of o.safeDirs ?? []) a.push("--safe-dir", expandHome(d));
	}
	return a;
}

function expandHome(p: string): string {
	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/**
 * Points a command at a profile's own galopin directory. `creds` is that directory's
 * credentials.json (everything else, mcp.json and the browser files, lives beside it); the
 * profile that owns galopin's default directory passes none. `service install` takes it after
 * `--`, as run flags. `setup TOOL` (not `--desktop`) has no such flag: the shims it writes follow
 * galopin's default pairing, which is the first profile's.
 */
export function withCreds(args: string[], creds: string | undefined): string[] {
	if (!creds) return args;
	const [cmd, sub] = args;
	if (cmd === "service") {
		if (sub !== "install") return args;
		const at = args.indexOf("--");
		return at < 0
			? [...args, "--", "--creds", creds]
			: [...args.slice(0, at + 1), "--creds", creds, ...args.slice(at + 1)];
	}
	if (cmd === "setup" && !args.includes("--desktop")) return args;
	if (cmd === "version" || cmd === "licenses") return args;
	const at = cmd === "browser" || cmd === "launch" || cmd === "setup" ? 2 : 1;
	return [...args.slice(0, at), "--creds", creds, ...args.slice(at)];
}

export const launchArgs = (tool: Tool) => ["launch", tool];
export const setupArgs = (tool: Tool, remove: boolean, makeDefault: boolean) => [
	"setup",
	tool,
	...(remove ? ["--remove"] : makeDefault ? ["--default"] : []),
];
export const upgradeArgs = (show: boolean) => ["upgrade", ...(show ? ["--show"] : ["--yes"])];
export const serviceArgs = (action: "install" | "uninstall" | "status") => ["service", action];

/** galopin's own config directory (where credentials.json lives): what Go's os.UserConfigDir gives. */
export function galopinConfigDir(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home = homedir()
): string {
	if (platform === "darwin")
		return join(env.HOME || home, "Library", "Application Support", "galopin");
	return join(env.XDG_CONFIG_HOME || join(env.HOME || home, ".config"), "galopin");
}

export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface Spawnable {
	command: string;
	args: string[];
}

/**
 * A terminal window that runs `argv` in `cwd` and stays open afterwards. macOS goes through
 * Terminal.app with AppleScript; Linux tries the usual emulators in order (`exists` says which
 * are installed).
 */
export function terminalCommand(
	platform: NodeJS.Platform,
	argv: string[],
	cwd: string,
	exists: (bin: string) => boolean
): Spawnable | undefined {
	const line = `cd ${shellQuote(cwd)} && ${argv.map(shellQuote).join(" ")}`;
	if (platform === "darwin") {
		const esc = line.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return {
			command: "osascript",
			args: [
				"-e",
				`tell application "Terminal" to activate`,
				"-e",
				`tell application "Terminal" to do script "${esc}"`,
			],
		};
	}
	const keep = `${line}; echo; echo "[done: press Enter to close]"; read _`;
	const candidates: [string, string[]][] = [
		["x-terminal-emulator", ["-e", "sh", "-c", keep]],
		["gnome-terminal", ["--", "sh", "-c", keep]],
		["konsole", ["-e", "sh", "-c", keep]],
		["xfce4-terminal", ["-e", `sh -c ${shellQuote(keep)}`]],
		["kitty", ["sh", "-c", keep]],
		["alacritty", ["-e", "sh", "-c", keep]],
		["xterm", ["-e", "sh", "-c", keep]],
	];
	for (const [bin, args] of candidates) if (exists(bin)) return { command: bin, args };
	return undefined;
}
