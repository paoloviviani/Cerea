/**
 * galopin runs from a copy the app keeps in its own data directory, never from where the app
 * happens to be. An AppImage runs from `/tmp/.mount_<random>/...`, which is gone when the app
 * quits and can be recreated by another local user; the shims `galopin setup` writes and the
 * service `galopin service install` writes both record the path of the galopin that wrote them
 * (`os.Executable()`), so that galopin must be a path that lasts and that only this user can write.
 * The copy is checked against the bundled binary's hash and made again when they differ (a new app
 * version, or a copy that was changed).
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "./bridgeServer.ts";

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function stableDir(userData: string): string {
	return join(userData, "bin");
}

/** The path of the stable copy of `bundled`, made (or made again) so its hash is the bundled one. */
export function ensureStableGalopin(opts: {
	bundled: string;
	userData: string;
	uid?: number;
}): string {
	const dir = stableDir(opts.userData);
	ensurePrivateDir(dir, opts.uid ?? process.getuid?.() ?? 0);
	const target = join(dir, "galopin");
	const want = sha256(opts.bundled);
	let have: string | undefined;
	try {
		have = sha256(target);
	} catch {
		have = undefined;
	}
	if (have !== want) {
		// Written beside it and moved into place, so a running galopin keeps its file and nothing sees half of one.
		const tmp = join(dir, `.galopin-${process.pid}-${Date.now()}`);
		copyFileSync(opts.bundled, tmp);
		chmodSync(tmp, 0o700);
		if (sha256(tmp) !== want) {
			rmSync(tmp, { force: true });
			throw new Error("The copy of galopin did not match the one built into the app.");
		}
		renameSync(tmp, target);
	}
	chmodSync(target, 0o700);
	return target;
}

/**
 * Rewrites a shim or service file so that every path to galopin that runs from an AppImage mount or
 * from the app's resources points at `stable` instead. Returns the new text, or undefined if there was
 * nothing to change.
 */
export function repointGalopin(
	text: string,
	stable: string,
	resourcesGalopin?: string
): string | undefined {
	let changed = false;
	// A path token ends at whitespace, a quote or an angle bracket (shell quoting, systemd and plist).
	const out = text.replace(/[^\s'"<>=]*\/galopin(?=[\s'"<>]|$)/g, (token) => {
		const stale = token.includes("/.mount_") || (!!resourcesGalopin && token === resourcesGalopin);
		if (!stale || token === stable) return token;
		changed = true;
		return stable;
	});
	return changed ? out : undefined;
}

/** The files that may name galopin: the shims in the given directories and the service unit. */
export function filesToRepoint(opts: { installDirs: string[]; home: string }): string[] {
	const files: string[] = [];
	for (const d of opts.installDirs) {
		for (const dir of [d, join(d, "galopin-shims")]) {
			if (!existsSync(dir)) continue;
			for (const f of readdirSync(dir)) {
				if (f === "galopin" || f.startsWith(".")) continue;
				files.push(join(dir, f));
			}
		}
	}
	files.push(join(opts.home, ".config", "systemd", "user", "galopin.service"));
	files.push(join(opts.home, "Library", "LaunchAgents", "org.cerea.galopin.plist"));
	return files;
}

/** Re-points what earlier runs wrote. Returns the files changed (a changed service unit needs a daemon reload). */
export function migrateGalopinPaths(opts: {
	stable: string;
	resourcesGalopin?: string;
	installDirs: string[];
	home: string;
}): string[] {
	const changed: string[] = [];
	for (const f of filesToRepoint(opts)) {
		let text: string;
		try {
			text = readFileSync(f, "utf8");
		} catch {
			continue;
		}
		// Only what galopin wrote: a shim has its marker, the unit and the plist name galopin.
		if (text.length > 100_000) continue;
		const next = repointGalopin(text, opts.stable, opts.resourcesGalopin);
		if (next === undefined) continue;
		writeFileSync(f, next, {
			mode: f.endsWith(".service") || f.endsWith(".plist") ? 0o644 : 0o755,
		});
		changed.push(f);
	}
	return changed;
}
