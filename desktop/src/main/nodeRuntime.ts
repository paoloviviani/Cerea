/**
 * The Node.js the app ships (pinned and checksum-verified when the app is built,
 * `scripts/fetch-node.mjs`) so the browser runtime needs nothing installed. It is run from a copy
 * in the app's data directory, not from the app itself: an AppImage mounts at a new path on every
 * start, and the connector entry galopin writes names Node by an absolute path that must last.
 * The copy is made once, when browser setup first needs it, and checked against the hash recorded
 * at build time; a copy that does not match is made again.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface NodeInfo {
	/** The directory to put first on PATH (holds `node` and `npm`). */
	binDir: string;
	version: string;
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function bundledNode(
	resources: string | undefined
): { dir: string; hash: string; version: string } | undefined {
	if (!resources) return undefined;
	const dir = join(resources, "node");
	try {
		const [hash, version] = readFileSync(join(dir, ".node-sha256"), "utf8").trim().split("\n");
		return hash && version && existsSync(join(dir, "bin", "node"))
			? { dir, hash, version }
			: undefined;
	} catch {
		return undefined;
	}
}

/** The shipped Node, installed under `userData/node/<version>`; undefined when the app has none (a development run). */
export function ensureNode(opts: {
	resources: string | undefined;
	userData: string;
}): NodeInfo | undefined {
	const b = bundledNode(opts.resources);
	if (!b) return undefined;
	const target = join(opts.userData, "node", b.version);
	const bin = join(target, "bin", "node");
	const ok = () => {
		try {
			return sha256(bin) === b.hash;
		} catch {
			return false;
		}
	};
	if (!ok()) {
		rmSync(target, { recursive: true, force: true });
		mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
		// Symlinks stay symlinks (bin/npm points into lib/node_modules/npm).
		cpSync(b.dir, target, { recursive: true, verbatimSymlinks: true });
		if (!ok()) throw new Error("The copy of Node did not match the one built into the app.");
		writeFileSync(join(target, ".installed-from"), `${b.version}\n`);
	}
	return { binDir: join(target, "bin"), version: b.version };
}
