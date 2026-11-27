// Runs electron-builder with the app's version set to the Cerea version (extraMetadata, so the
// packaged package.json, app.getVersion() and the artifact names carry it). Arguments pass through:
//   node scripts/package.mjs --linux AppImage deb
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cereaVersion } from "./cerea-version.mjs";

const root = join(import.meta.dirname, "..");
const bin = join(root, "node_modules", ".bin", "electron-builder");
const res = spawnSync(
	bin,
	[
		`--config.extraMetadata.version=${cereaVersion()}`,
		"--publish",
		"never",
		...process.argv.slice(2),
	],
	{ cwd: root, stdio: "inherit" }
);
if (res.status !== 0) process.exit(res.status ?? 1);
