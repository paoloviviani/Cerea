// Checks a packaged app's resources directory, as electron-builder wrote it, and runs what is in it:
//   node scripts/check-packaged.mjs release/linux-unpacked/resources
//   node scripts/check-packaged.mjs release/mac-arm64/Cerea.app/Contents/Resources
// v0.67.0 shipped browser-runtime/ without node_modules/playwright-core (electron-builder drops a
// node_modules directly under an extraResources `from`), and the smoke tests run unpackaged, so
// only a check of the package itself sees it. It runs the runtime with the PACKAGED Node, the way
// the app does (windowBrowser.ts), and fails on any missing module.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cereaVersion } from "./cerea-version.mjs";

const res = resolve(process.argv[2] ?? "");
assert.ok(
	process.argv[2] && existsSync(res),
	`usage: check-packaged.mjs RESOURCES_DIR (got ${res})`
);
const version = cereaVersion();
const rt = join(res, "browser-runtime");
const node = join(res, "node", "bin", "node");
const galopin = join(res, "galopin", "galopin");

function mustExist(path) {
	assert.ok(existsSync(path), `missing from the package: ${path}`);
	console.log(`ok   ${path.slice(res.length + 1)}`);
}

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000, ...opts });
	if (r.status !== 0) {
		console.error(r.stdout, r.stderr, r.error ?? "");
		assert.fail(`${cmd} ${args.join(" ")} exited ${r.status}`);
	}
	return r.stdout;
}

mustExist(join(rt, "cerea-browser.mjs"));
mustExist(join(rt, "node_modules", "playwright-core", "package.json"));
mustExist(node);
mustExist(join(res, "node", ".node-sha256"));
mustExist(join(res, "node", "lib", "node_modules", "npm", "package.json"));
mustExist(galopin);

const pinned = JSON.parse(
	readFileSync(
		join(import.meta.dirname, "..", "..", "agent", "internal", "browserrt", "package.json"),
		"utf8"
	)
).dependencies["playwright-core"];
const shipped = JSON.parse(
	readFileSync(join(rt, "node_modules", "playwright-core", "package.json"), "utf8")
).version;
assert.equal(shipped, pinned, "the packaged playwright-core is not the version the runtime pins");

// Run from a copy outside the source tree: release/ sits under desktop/, whose own node_modules
// would otherwise resolve playwright-core for a package that lacks it.
const copy = realpathSync(mkdtempSync(join(tmpdir(), "cerea-packaged-")));
process.on("exit", () => rmSync(copy, { recursive: true, force: true }));
for (const d of ["browser-runtime", "node"]) {
	cpSync(join(res, d), join(copy, d), { recursive: true, verbatimSymlinks: true });
}
const crt = join(copy, "browser-runtime");
const cnode = join(copy, "node", "bin", "node");

// The runtime as the app starts it: its static imports (playwright-core) resolve before --help runs.
const help = run(cnode, [join(crt, "cerea-browser.mjs"), "--help"], { cwd: crt });
assert.match(help, /--connect-file/, "cerea-browser --help printed no usage");
console.log("ok   the packaged node runs browser-runtime/cerea-browser.mjs --help");

// And the module itself, resolved and imported from the runtime's own directory (an ES module
// evaluated with --input-type resolves from the working directory).
const imported = run(
	cnode,
	[
		"--input-type=module",
		"-e",
		`const pw = await import("playwright-core");
		const chromium = pw.chromium ?? pw.default?.chromium;
		if (typeof chromium?.connectOverCDP !== "function") throw new Error("no chromium.connectOverCDP");
		console.log(new URL(import.meta.resolve("playwright-core")).pathname);`,
	],
	{ cwd: crt }
).trim();
assert.ok(imported.startsWith(crt), `playwright-core resolved outside the package: ${imported}`);
console.log(`ok   the packaged node imports ${imported.slice(crt.length + 1)}`);

// The app and its galopin carry the Cerea version.
const galopinVersion = run(galopin, ["version"]).trim();
assert.equal(galopinVersion, version, "the packaged galopin does not report the Cerea version");
console.log(`ok   galopin version ${galopinVersion}`);
const asar = await import("@electron/asar");
const extractFile = asar.extractFile ?? asar.default.extractFile;
const appVersion = JSON.parse(
	extractFile(join(res, "app.asar"), "package.json").toString()
).version;
assert.equal(
	appVersion,
	version,
	"the packaged app's package.json does not carry the Cerea version"
);
console.log(`ok   app version ${appVersion}`);
console.log(`packaged app checked: ${res}`);
