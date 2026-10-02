/**
 * Copy the Pyodide runtime files from the npm package into `static/pyodide/`.
 *
 * The runtime is ~12 MB of wasm/zip assets that must be served same-origin
 * (the worker's fetch allowlist only permits same-origin /pyodide/* paths), so
 * they are regular static assets built from the installed dependency rather
 * than a CDN link. They are gitignored: `npm run sync-pyodide` (wired as the
 * predev/prebuild hook) regenerates them from `node_modules/pyodide`, so the
 * tree stays small and the deployed version always matches the pinned package.
 *
 * Only the files the runtime actually loads are copied — no sourcemaps, no
 * UMD bundle, no console demos. pyodide-lock.json travels along so a future
 * `micropip` index pointed at this directory has consistent metadata, even
 * though the package wheels themselves are deliberately not vendored.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const RUNTIME_FILES = [
	"pyodide.mjs",
	"pyodide.mjs.map",
	"pyodide.asm.mjs",
	"pyodide.asm.wasm",
	"python_stdlib.zip",
	"pyodide-lock.json",
];

const packageRoot = path.resolve("node_modules/pyodide");
const outRoot = path.resolve("static/pyodide");

const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
await mkdir(outRoot, { recursive: true });

let copied = 0;
for (const name of RUNTIME_FILES) {
	const source = path.join(packageRoot, name);
	const target = path.join(outRoot, name);
	try {
		const [src, dst] = await Promise.all([stat(source), stat(target)]);
		if (src.size === dst.size && dst.mtimeMs >= src.mtimeMs) continue;
	} catch {
		// Either file missing: fall through to the copy.
	}
	await copyFile(source, target);
	copied += 1;
}

const versionMarker = path.join(outRoot, ".pyodide-version");
const expected = `${pkg.version}\n`;
let current = "";
try {
	current = await readFile(versionMarker, "utf8");
} catch {
	// First sync on this tree.
}
if (current !== expected) {
	// The npm package ships no standalone LICENSE file (only the package.json
	// declaration), so attribution is a generated notice naming the version.
		await writeFile(
			path.join(outRoot, "NOTICE.txt"),
			`Pyodide ${pkg.version}\nhttps://github.com/pyodide/pyodide\nLicense: MPL-2.0\nServed unmodified from the pyodide npm package (see package-lock.json for the pinned integrity hash).\n\nThe package distribution's wheels each carry their own licence inside the archive.\nAmong them are LGPL-3.0+ components (gmpy2, built with GMP and MPFR; and the GDAL wheel),\nwhich are unmodified upstream builds — source: https://github.com/pyodide/pyodide and\neach project's upstream repository.\n`
		);
	await writeFile(versionMarker, expected);
}

console.log(`[sync-pyodide] pyodide ${pkg.version}: ${copied} file(s) copied to static/pyodide/`);
