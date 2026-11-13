/**
 * What makes the Cerea browser recognisable among the user's windows: its own theme colour, the
 * profile name "Cerea", and a small local start page on its first tab. Chrome's colour and name are
 * preferences in the profile directory, so they are written before Chrome starts, and never while
 * it runs (it would overwrite them on exit, and a half-written file would be read by a live
 * browser). No extension is used: branded Chrome no longer loads them.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readlink, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

/** Cerea's accent (violet-700, #7008e7) as the signed ARGB integer Chrome stores. */
export const CEREA_ACCENT_ARGB = 0xff7008e7 | 0;
export const CEREA_PROFILE_NAME = "Cerea";

/**
 * Chrome's own names (checked against the strings of Chrome 158): `user_color2` the seed colour
 * of "Customize Chrome", `color_variant2` its style (1: tonal spot), `is_grayscale2`,
 * `color_scheme2` (0: follow the system light/dark setting).
 */
export const THEME_PREFS = {
	user_color2: CEREA_ACCENT_ARGB,
	color_variant2: 1,
	is_grayscale2: false,
	color_scheme2: 0,
} as const;

export type ProfileResult =
	{ written: true } | { written: false; reason: "running" | "unreadable" | "failed" };

/** Chrome keeps `SingletonLock` -> "host-pid" in the user-data-dir while a browser runs on it. */
export async function profileIsRunning(dir: string): Promise<boolean> {
	let target: string;
	try {
		target = await readlink(join(dir, "SingletonLock"));
	} catch {
		return false;
	}
	const cut = target.lastIndexOf("-");
	const pid = Number(target.slice(cut + 1));
	if (!Number.isInteger(pid) || pid <= 0) return true; // a lock we cannot read counts as running
	// A lock made on another computer (a profile on a shared disk) cannot be checked here.
	if (cut > 0 && target.slice(0, cut) !== hostname()) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** The file's JSON object: {} when absent, null when it exists and is not a JSON object. */
async function readJson(path: string): Promise<Json | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
	}
	if (text.trim() === "") return {};
	try {
		const parsed: unknown = JSON.parse(text);
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

async function writeAtomic(path: string, data: Json): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.cerea-${randomBytes(4).toString("hex")}.tmp`;
	try {
		const file = await open(tmp, "w", 0o600);
		try {
			await file.writeFile(JSON.stringify(data));
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

/** A profile name nobody chose: unset, Chrome's own default, or what this wrote before. */
function isOurs(name: unknown): boolean {
	return (
		name === undefined ||
		name === CEREA_PROFILE_NAME ||
		(typeof name === "string" && /^(Person \d+|Your Chrome|Default)$/.test(name))
	);
}

function child(parent: Json, key: string): Json {
	const existing = parent[key];
	if (isObject(existing)) return existing;
	const made: Json = {};
	parent[key] = made;
	return made;
}

/**
 * Sets the profile's theme colour and name, merging into what is there. Nothing is written while
 * Chrome runs on the profile, and a file that is not JSON is left alone (Chrome repairs its own).
 */
export async function applyCereaProfile(
	dir: string,
	name: string = CEREA_PROFILE_NAME
): Promise<ProfileResult> {
	try {
		if (await profileIsRunning(dir)) return { written: false, reason: "running" };
		const prefsPath = join(dir, "Default", "Preferences");
		const statePath = join(dir, "Local State");
		const prefs = await readJson(prefsPath);
		const state = await readJson(statePath);
		if (!prefs || !state) return { written: false, reason: "unreadable" };

		// Only what is unset or still ours: a theme or name the user chose is theirs.
		const theme = child(child(prefs, "browser"), "theme");
		if (theme.user_color2 === undefined || theme.user_color2 === CEREA_ACCENT_ARGB) {
			Object.assign(theme, THEME_PREFS);
		}
		const profile = child(prefs, "profile");
		if (isOurs(profile.name)) {
			profile.name = name;
			profile.using_default_name = false;
		}
		const info = child(child(child(state, "profile"), "info_cache"), "Default");
		if (isOurs(info.name)) {
			info.name = name;
			info.is_using_default_name = false;
		}

		await writeAtomic(prefsPath, prefs);
		await writeAtomic(statePath, state);
		return { written: true };
	} catch {
		return { written: false, reason: "failed" };
	}
}

// ----- the start page --------------------------------------------------------------------

/** Served by the runtime itself (a route answers it): the address never reaches the network. */
export const START_URL = "https://start.cerea.invalid/";

export function isStartUrl(url: string): boolean {
	return url === START_URL;
}

/** A blank or start page: nothing a user would want read or lent. */
export function isBlankUrl(url: string): boolean {
	return url === "about:blank" || isStartUrl(url);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The start page: static, no script, no network, nothing secret. */
export function startPageHtml(computer: string): string {
	const name = escapeHtml(computer.slice(0, 80) || "this computer");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cerea browser</title>
<style>
html{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,sans-serif;background:#f5f3ff;color:#1a1a1a}
@media (prefers-color-scheme:dark){body{background:#1b1230;color:#f1ecff}}
main{text-align:center;padding:2rem;max-width:32rem}
svg{width:72px;height:72px}
h1{font-size:1.5rem;margin:1rem 0 .5rem}
p{margin:0;opacity:.8}
</style></head>
<body><main>
<svg viewBox="0 0 72 72" role="img" aria-label="Cerea"><circle cx="36" cy="36" r="34" fill="#7008e7"/><path d="M45 25a14 14 0 1 0 0 22" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/></svg>
<h1>Cerea browser on ${name}</h1>
<p>Cerea can use the tabs in this window when you ask in a chat.</p>
</main></body></html>`;
}
