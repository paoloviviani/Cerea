// Downloads the pinned Node.js for one platform into resources/node, checking the tarball against
// the SHA-256 in node-pins.json before anything is unpacked. Usage: node scripts/fetch-node.mjs <linux|darwin> <x64|arm64>
// The app ships it so that browser use needs no Node on the computer (npm comes with it: galopin
// installs the runtime's one dependency with it).
import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const pins = JSON.parse(readFileSync(join(root, "node-pins.json"), "utf8"));
const [os, arch] = process.argv.slice(2);
const key = `${os}-${arch}`;
const expected = pins.sha256[key];
if (!expected) {
	console.error(`usage: fetch-node.mjs <linux|darwin> <x64|arm64> (no pin for "${key}")`);
	process.exit(2);
}
const name = `node-v${pins.version}-${key}.tar.gz`;
const out = join(root, "resources", "node");
const tmp = join(process.env.TMPDIR ?? "/tmp", `cerea-node-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const tgz = join(tmp, name);

const res = await fetch(`https://nodejs.org/dist/v${pins.version}/${name}`);
if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
await pipeline(Readable.fromWeb(res.body), createWriteStream(tgz));

const hash = createHash("sha256");
await pipeline(createReadStream(tgz), hash);
const got = hash.digest("hex");
if (got !== expected) {
	rmSync(tmp, { recursive: true, force: true });
	console.error(`CHECKSUM MISMATCH for ${name}: expected ${expected}, got ${got}`);
	process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const tar = spawnSync("tar", ["-xzf", tgz, "-C", out, "--strip-components=1"], {
	stdio: "inherit",
});
if (tar.status !== 0) throw new Error("tar failed");
// Not needed to run npm and the browser runtime: headers, man pages, docs, corepack.
for (const p of [
	"include",
	"share",
	"CHANGELOG.md",
	"README.md",
	"lib/node_modules/corepack",
	"bin/corepack",
]) {
	await rm(join(out, p), { recursive: true, force: true });
}
// What the app compares its copy against at first use.
const bin = createHash("sha256");
await pipeline(createReadStream(join(out, "bin", "node")), bin);
writeFileSync(join(out, ".node-sha256"), `${bin.digest("hex")}\n${pins.version}\n`);
rmSync(tmp, { recursive: true, force: true });
console.log(`node ${pins.version} ${key} -> resources/node (verified ${expected.slice(0, 12)}...)`);
