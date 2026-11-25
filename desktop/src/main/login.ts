/**
 * Start at login, opt in. macOS: a login item (`app.setLoginItemSettings`). Linux: an XDG
 * autostart entry in `~/.config/autostart`. Nothing is registered unless the user turns it on in
 * Settings, and turning it off removes exactly what was written.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AUTOSTART_FILE = "cerea-desktop.desktop";

/** One argument of an Exec line, quoted the way the Desktop Entry spec asks. */
export function execQuote(arg: string): string {
	if (/^[A-Za-z0-9_\-./:=+@,]+$/.test(arg)) return arg;
	return `"${arg.replace(/(["`$\\])/g, "\\$1").replace(/%/g, "%%")}"`;
}

export function autostartEntry(exec: string[]): string {
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=Cerea",
		"Comment=Cerea desktop app",
		`Exec=${exec.map(execQuote).join(" ")}`,
		"Terminal=false",
		"X-GNOME-Autostart-enabled=true",
		"",
	].join("\n");
}

export function autostartPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(
		env.XDG_CONFIG_HOME || join(env.HOME || home, ".config"),
		"autostart",
		AUTOSTART_FILE
	);
}

/** What to run at login: the AppImage itself when running from one, else the executable. */
export function loginCommand(env: NodeJS.ProcessEnv, execPath: string): string[] {
	return [env.APPIMAGE || execPath];
}

export function linuxLogin(
	enabled: boolean,
	opts: { env?: NodeJS.ProcessEnv; execPath: string; home?: string }
): void {
	const env = opts.env ?? process.env;
	const file = autostartPath(env, opts.home);
	if (!enabled) return rmSync(file, { force: true });
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, autostartEntry(loginCommand(env, opts.execPath)), { mode: 0o644 });
}

export function linuxLoginEnabled(env: NodeJS.ProcessEnv = process.env, home?: string): boolean {
	return existsSync(autostartPath(env, home));
}
